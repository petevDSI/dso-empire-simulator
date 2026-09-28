// Vercel serverless function: confirms with Stripe (server-to-server, using the
// secret key) that a Checkout session actually completed payment, before the game
// grants the Legendary Card Pack. This check MUST happen server-side — trusting a
// client-supplied "I paid" flag would let anyone grant themselves cards for free.
//
// Requires the STRIPE_SECRET_KEY environment variable (see create-checkout-session.js).

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ paid: false, error: "Payments aren't configured yet on this server." });
    return;
  }

  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
  const playerId = typeof req.query.player_id === "string" ? req.query.player_id : "";

  if (!sessionId) {
    res.status(400).json({ paid: false, error: "Missing session_id" });
    return;
  }

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const paidOk = session && session.payment_status === "paid";
    // client_reference_id ties the session back to the browser that started checkout.
    // If the caller didn't send a player_id (older client, or direct API probing),
    // fall back to just the payment status; if it did, both must line up.
    const playerOk = !playerId || session.client_reference_id === playerId;

    res.status(200).json({
      paid: Boolean(paidOk && playerOk),
      amount_total: session ? session.amount_total : null,
      currency: session ? session.currency : null,
    });
  } catch (err) {
    console.error("verify-checkout-session error:", err && err.message);
    res.status(200).json({ paid: false, error: "not_found" });
  }
};
