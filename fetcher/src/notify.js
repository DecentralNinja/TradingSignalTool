// Free WhatsApp notifications via SendZen (https://www.sendzen.io) -- their
// sandbox tier, safe opt-in-by-message (not account-linking: SendZen never
// gets access to your other WhatsApp chats, confirmed on their own setup
// page). Free tier: 4,500 credits/month, resets monthly.
//
// Requires WHATSAPP_PHONE, SENDZEN_API_KEY, and SENDZEN_FROM_NUMBER env
// vars; if any are missing, notifications are silently skipped (not
// configured yet, not an error). A notification failure must never break
// the fetch cycle -- this never throws.
//
// Caveat discovered during setup: SendZen's sandbox requires approved
// templates for business-initiated messages EXCEPT within a 24h session
// window opened by the recipient messaging the sandbox number first (standard
// WhatsApp policy, not SendZen-specific). Free-form text (used here) was
// confirmed working right after opting in. If it silently stops working
// after ~24h of no reply from the recipient, that's the session window
// closing -- message the sandbox number again to reopen it. Logged as an
// error here if it happens, not treated as fatal.
const SENDZEN_URL = 'https://api.sendzen.io/v1/messages'

export async function sendWhatsApp(message) {
  const phone = process.env.WHATSAPP_PHONE
  const apiKey = process.env.SENDZEN_API_KEY
  const fromNumber = process.env.SENDZEN_FROM_NUMBER
  if (!phone || !apiKey || !fromNumber) return

  try {
    const res = await fetch(SENDZEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromNumber,
        to: phone,
        type: 'text',
        text: { body: message },
      }),
    })
    if (!res.ok) {
      console.error(`WhatsApp notify failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    console.error(`WhatsApp notify failed: ${err.message}`)
  }
}
