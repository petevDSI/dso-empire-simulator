// Vercel serverless function: starts a real-money Stripe Checkout session for the
// Legendary Card Pack ($1.99 for 3 cards, each an independent equal-odds draw from
// the 5 Legendary desk cards). Card data never touches this function or the game's
// own code — Stripe's hosted Checkout page handles all payment details directly.
//
// Requires the STRIPE_SECRET_KEY environment variable to be set in the Vercel
// project (Project Settings -> Environment Variables), using the secret key from
// the Stripe account that should receive these payments. No Product/Price needs to
// be pre-created in the Stripe dashboard — the price is defined inline below.

const PACK_PRICE_USD_CENTS = 199;
const PACK_NAME = "DSO Empire Simulator — Legendary Card Pack (3 cards)";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: "Payments aren't configured yet on this server." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const playerId = typeof body.playerId === "string" ? body.playerId.slice(0, 128) : "";
  if (!playerId) {
    res.status(400).json({ error: "Missing playerId" });
    return;
  }

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const origin =
      (req.headers.origin && String(req.headers.origin)) ||
      "https://" + (req.headers.host || "empire.dentalstrategyinstitute.com");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: PACK_NAME,
              description:
                "3 cards, each independently drawn from the 5 Legendary desk cards at equal odds (20% each). Duplicates are possible and still count toward your permanent bonus.",
            },
            unit_amount: PACK_PRICE_USD_CENTS,
          },
          quantity: 1,
        },
      ],
      client_reference_id: playerId,
      success_url: origin + "/?pack_session={CHECKOUT_SESSION_ID}",
      cancel_url: origin + "/?pack_cancelled=1",
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err && err.message);
    res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
};
