// public/config.js (or ./config.js in your repo)
(function () {
  const host = location.hostname;
  const isLocal = host === '127.0.0.1' || host === 'localhost';

  window.APP_CONFIG = {
    BRAND_NAME:   'Agentlyne',
    SUPPORT_EMAIL:'support@agentlyne.com',
    // Local dev hits your Node server; prod hits your proxied API
    API_BASE: isLocal ? 'http://127.0.0.1:5050' : 'https://api.agentlyne.com'
  };
})();
