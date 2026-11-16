/**
 * Payhip -> Discord webhook relay (Cloudflare Worker)
 *
 * Secrets / variables (set in Cloudflare dashboard or via `wrangler secret put`):
 *   DISCORD_WEBHOOK_URL  (required) Your Discord webhook URL
 *   PAYHIP_API_KEY       (required) Payhip Settings > Developer > API key
 *   SHOW_EMAIL           (optional) set to "false" to hide customer emails in Discord
 */

const COLORS = {
  paid: 0x2ecc71,
  refunded: 0xe74c3c,
  "subscription.created": 0x3498db,
  "subscription.deleted": 0x95a5a6,
};

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string comparison
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Payhip prices are in cents/pennies
function money(cents, currency) {
  return `${(Number(cents || 0) / 100).toFixed(2)} ${currency || ""}`.trim();
}

function ts(unix) {
  return unix ? `<t:${unix}:f>` : "—";
}

function clip(str, max = 1024) {
  str = String(str ?? "—");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function buildEmbed(data, showEmail) {
  const type = data.type;
  const color = COLORS[type] ?? 0x7289da;

  if (type === "paid" || type === "refunded") {
    const items = (data.items || [])
      .map((i) => {
        const tags = [];
        if (i.used_coupon) tags.push("coupon");
        if (i.on_sale) tags.push("sale");
        if (i.promoted_by_affiliate) tags.push("affiliate");
        if (i.has_variant) tags.push("variant");
        const url = i.product_permalink ? `[${i.product_name}](${i.product_permalink})` : i.product_name;
        return `• ${url} × ${i.quantity}${tags.length ? ` _(${tags.join(", ")})_` : ""}`;
      })
      .join("\n");

    const isRefund = type === "refunded";
    const fullRefund = isRefund && data.amount_refunded === data.price;

    const fields = [
      { name: "Items", value: clip(items || "—") },
      {
        name: isRefund ? "Refunded" : "Amount",
        value: money(isRefund ? data.amount_refunded : data.price, data.currency),
        inline: true,
      },
    ];
    if (isRefund) fields.push({ name: "Type", value: fullRefund ? "Full refund" : "Partial refund", inline: true });
    if (showEmail) fields.push({ name: "Customer", value: clip(data.email, 256), inline: true });
    fields.push({ name: "Payment", value: clip(data.payment_type, 256), inline: true });
    if (data.is_gift) fields.push({ name: "Gift", value: "Yes", inline: true });
    fields.push({
      name: "Fees",
      value: `Payhip ${money(data.payhip_fee, data.currency)} • Stripe ${money(data.stripe_fee, data.currency)}`,
    });

    return {
      title: isRefund ? "↩️ Refund" : "💰 New sale",
      color,
      fields,
      footer: { text: `Transaction ${data.id}` },
      timestamp: new Date((isRefund ? data.date_refunded : data.date) * 1000).toISOString(),
    };
  }

  if (type === "subscription.created" || type === "subscription.deleted") {
    const created = type === "subscription.created";
    const name = [data.customer_first_name, data.customer_last_name].filter(Boolean).join(" ");
    const fields = [
      { name: "Product", value: clip(data.product_name, 256), inline: true },
      { name: "Plan", value: clip(data.plan_name, 256), inline: true },
      { name: "Customer", value: clip(name || "—", 256), inline: true },
    ];
    if (showEmail) fields.push({ name: "Email", value: clip(data.customer_email, 256), inline: true });
    fields.push({ name: "Started", value: ts(data.date_subscription_started), inline: true });
    if (!created) fields.push({ name: "Canceled", value: ts(data.date_subscription_deleted), inline: true });

    return {
      title: created ? "🔔 New subscriber" : "❌ Subscription canceled",
      color,
      fields,
      footer: { text: `Subscription ${data.subscription_id}` },
    };
  }

  // Unknown event type: show raw type so nothing is silently lost
  return { title: `Payhip event: ${type}`, color, description: "```json\n" + clip(JSON.stringify(data, null, 2), 3900) + "\n```" };
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Payhip → Discord relay is running.", { status: 200 });
    }

    if (!env.DISCORD_WEBHOOK_URL || !env.PAYHIP_API_KEY) {
      return new Response("Worker is missing required secrets", { status: 500 });
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Verify the request came from Payhip: signature = sha256(API key)
    const expected = await sha256Hex(env.PAYHIP_API_KEY);
    if (!safeEqual(data.signature, expected)) {
      return new Response("Invalid signature", { status: 401 });
    }

    const showEmail = String(env.SHOW_EMAIL ?? "true").toLowerCase() !== "false";

    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Payhip",
        embeds: [buildEmbed(data, showEmail)],
      }),
    });

    if (!res.ok) {
      // Non-200 makes Payhip retry (hourly, up to 3 hours), which is useful if Discord had a hiccup
      return new Response(`Discord error ${res.status}`, { status: 502 });
    }

    // Payhip requires a 200 response
    return new Response("ok", { status: 200 });
  },
};
