// Relays requests to Binance's futures API. GitHub Actions' hosted runners are
// blocked by Binance (HTTP 451, US datacenter IPs), so the fetcher calls this
// Worker instead and this Worker calls Binance from Cloudflare's edge network.
export default {
  async fetch(request) {
    const url = new URL(request.url)
    const allowedPrefixes = ['/fapi/', '/futures/']

    if (!allowedPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      return new Response('Not allowed', { status: 403 })
    }

    const target = `https://fapi.binance.com${url.pathname}${url.search}`
    const res = await fetch(target)

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    })
  },
}
