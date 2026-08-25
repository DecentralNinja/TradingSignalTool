// WhatsApp notifications via our own self-hosted bridge (whatsapp-bridge/,
// Baileys-based) -- posts to a private WhatsApp Channel we own, rather than
// through the official WhatsApp Business Platform. This sidesteps both
// problems that blocked the Meta Cloud API / SendZen path: no 24h
// session-window restriction (that's a Business Platform policy, not a
// WhatsApp-wide rule), and no dedicated phone number requirement. No third
// party ever sees the messages -- the bridge runs entirely on our own
// infrastructure.
//
// Requires WHATSAPP_BRIDGE_URL and WHATSAPP_BRIDGE_SECRET env vars; if
// either is missing, notifications are silently skipped (not configured
// yet, not an error). A notification failure must never break the fetch
// cycle -- this never throws.
export async function sendWhatsApp(message) {
  const bridgeUrl = process.env.WHATSAPP_BRIDGE_URL
  const bridgeSecret = process.env.WHATSAPP_BRIDGE_SECRET
  if (!bridgeUrl || !bridgeSecret) return

  try {
    const res = await fetch(`${bridgeUrl}/send`, {
      method: 'POST',
      headers: {
        'x-bridge-secret': bridgeSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    })
    if (!res.ok) {
      console.error(`WhatsApp notify failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    console.error(`WhatsApp notify failed: ${err.message}`)
  }
}
