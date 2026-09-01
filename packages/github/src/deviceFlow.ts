/**
 * GitHub OAuth Device Flow — chosen over the standard web/redirect flow
 * because a desktop app has no stable HTTPS redirect URI to register, and
 * device flow needs no client secret at all (it's a "public client" flow),
 * so nothing sensitive has to be embedded or configured beyond the client
 * ID. Requires "Device Flow" enabled on the GitHub OAuth App's settings.
 */

export type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export async function startDeviceFlow(clientId: string): Promise<DeviceCodeResponse> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "repo read:user" }),
  });

  if (!res.ok) {
    throw new Error(`GitHub device code request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

export type PollResult =
  | { status: "pending" }
  | { status: "success"; accessToken: string }
  | { status: "expired" }
  | { status: "error"; message: string };

/** Polls once. Caller is responsible for spacing calls by `interval` seconds (device flow rate-limits faster polling). */
export async function pollDeviceToken(clientId: string, deviceCode: string): Promise<PollResult> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (data.access_token) {
    return { status: "success", accessToken: data.access_token };
  }
  if (data.error === "authorization_pending") {
    return { status: "pending" };
  }
  if (data.error === "expired_token") {
    return { status: "expired" };
  }
  if (data.error === "slow_down") {
    // Caller should just wait for its next scheduled poll; treat as pending.
    return { status: "pending" };
  }
  return { status: "error", message: data.error_description ?? data.error ?? "Unknown GitHub OAuth error" };
}
