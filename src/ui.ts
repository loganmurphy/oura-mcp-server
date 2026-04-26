// OAuth login and success page templates.

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderLoginPage(oauthParams: string, failed: boolean, rateLimited = false): string {
  const errorHtml = rateLimited
    ? `<p class="error">Too many attempts — please wait a minute and try again.</p>`
    : failed
    ? `<p class="error">Incorrect password — please try again.</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Oura MCP — Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0;
    }
    .card {
      background: white; border-radius: 12px; padding: 2rem;
      width: 100%; max-width: 360px;
      box-shadow: 0 4px 24px rgba(0,0,0,.08);
    }
    h1 { margin: 0 0 .4rem; font-size: 1.25rem; }
    .subtitle { margin: 0 0 1.5rem; color: #666; font-size: .875rem; }
    label { display: block; font-size: .875rem; font-weight: 500; margin-bottom: .4rem; }
    input[type=password] {
      width: 100%; padding: .6rem .8rem;
      border: 1px solid #ddd; border-radius: 8px;
      font-size: 1rem; margin-bottom: 1rem;
      outline-offset: 2px;
    }
    input[type=password]:focus { border-color: #5865f2; outline: 2px solid #5865f222; }
    button {
      width: 100%; padding: .7rem;
      background: #5865f2; color: white;
      border: none; border-radius: 8px;
      font-size: 1rem; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #4752c4; }
    .error {
      color: #b91c1c; background: #fef2f2;
      border: 1px solid #fecaca; border-radius: 6px;
      padding: .6rem .8rem; margin-bottom: 1rem; font-size: .875rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔒 Oura MCP Server</h1>
    <p class="subtitle">Enter your password to authorize access.</p>
    ${errorHtml}
    <form method="POST" action="/authorize">
      <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
      <label for="password">Password</label>
      <input type="password" id="password" name="password"
             autofocus autocomplete="current-password" placeholder="Enter password">
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

export function renderSuccessPage(redirectTo: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Oura MCP — Connected</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0;
    }
    .card {
      background: white; border-radius: 12px; padding: 2rem;
      width: 100%; max-width: 360px;
      box-shadow: 0 4px 24px rgba(0,0,0,.08);
      text-align: center;
    }
    .check {
      width: 52px; height: 52px; margin: 0 auto 1.25rem;
      background: #dcfce7; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
    }
    .check svg { width: 26px; height: 26px; }
    h1 { margin: 0 0 .4rem; font-size: 1.25rem; color: #111; }
    .subtitle { color: #666; font-size: .875rem; line-height: 1.5; margin: 0 0 1.25rem; }
    .tip {
      background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px;
      padding: .75rem 1rem; text-align: left;
    }
    .tip-title { margin: 0 0 .25rem; font-size: .8rem; font-weight: 600; color: #0c4a6e; }
    .tip p { margin: 0; font-size: .8rem; color: #0369a1; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">
      <svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
    <h1>Connected to Oura</h1>
    <p class="subtitle">Authorization successful. You can close this window and return to Claude.</p>
    <div class="tip">
      <p class="tip-title">Enable all tools</p>
      <p>Find the Oura connector in Claude → click <b>Configure</b> → set each tool to <b>Allow</b>. Without this, Claude may ask for permission on every use.</p>
    </div>
  </div>
  <!-- Complete the OAuth code exchange silently so mcp-remote gets its token -->
  <iframe src="${escapeHtml(redirectTo)}" style="display:none" title="oauth-callback" aria-hidden="true"></iframe>
</body>
</html>`;
}
