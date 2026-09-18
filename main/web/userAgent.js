//AO3 answers a request that carries NO User-Agent header with
//HTTP 403 and its "Shields are up!" page. Verified against the live site: a
//browser UA, a CFNetwork UA and an okhttp UA all return 200, and only the
//absent header is refused. React Native does not reliably attach one, so every
//outbound request in this app sets it explicitly.
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

//The headers a normal page load carries. Spread this into a request and add
//whatever else it needs.
export const BROWSER_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};
