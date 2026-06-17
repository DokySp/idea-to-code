const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/exchange") {
      return json({ error: "not_found" }, request, env, 404);
    }

    if (!isAllowedOrigin(request, env)) {
      return json({ error: "origin_not_allowed" }, request, env, 403);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "invalid_json" }, request, env, 400);
    }

    if (!payload.code || !payload.redirect_uri) {
      return json({ error: "missing_code_or_redirect_uri" }, request, env, 400);
    }

    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: payload.code,
        redirect_uri: payload.redirect_uri,
      }),
    });

    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || tokenBody.error) {
      return json(
        {
          error: tokenBody.error || "github_oauth_failed",
          error_description: tokenBody.error_description || tokenResponse.statusText,
        },
        request,
        env,
        502,
      );
    }

    return json(
      {
        access_token: tokenBody.access_token,
        token_type: tokenBody.token_type,
        scope: tokenBody.scope,
      },
      request,
      env,
    );
  },
};

function json(body, request, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(request, env) ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}
