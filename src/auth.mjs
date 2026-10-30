import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AUTH_FILE = path.join(os.homedir(), '.mcl', 'auth.json');
const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const SCOPES = 'XboxLive.signin offline_access';

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data.error_description || data.error || res.status;
    throw new Error(`${url} 失败：${detail}`);
  }
  return data;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveAuth(data) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return AUTH_FILE;
}

/** 1. 申请设备码：返回 user_code / verification_uri / device_code（必须 form 编码） */
export async function requestDeviceCode(clientId) {
  if (!clientId) throw new Error('缺少 client_id（Azure 应用的应用程序 ID）');
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`申请设备码失败：${data.error_description || data.error || res.status}`);
  }
  return data;
}

/** 2. 轮询令牌，直到用户完成授权 */
export async function pollForToken(clientId, deviceCode, { interval = 5, timeoutMs = 300_000, onTick } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { ok, data } = await postForm(TOKEN_URL, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    });
    if (ok && data.access_token) return data;
    if (data.error === 'authorization_pending') {
      onTick?.();
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      continue;
    }
    if (data.error === 'slow_down') {
      await new Promise((resolve) => setTimeout(resolve, (interval + 5) * 1000));
      continue;
    }
    if (data.error === 'expired_token') throw new Error('设备码已过期，请重新登录');
    if (data.error === 'authorization_declined') throw new Error('用户取消了授权');
    throw new Error(`授权失败：${data.error_description || data.error || 'unknown'}`);
  }
  throw new Error('等待授权超时');
}

/** 3. Xbox Live 认证 → XSTS */
export async function xboxAuth(accessToken) {
  const user = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [user.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
  if (!uhs) throw new Error('XSTS 返回缺少 uhs');
  return { userToken: user.Token, xstsToken: xsts.Token, uhs };
}

/** 4. 用 XSTS 换 Minecraft 令牌 */
export async function minecraftLogin(xstsToken, uhs) {
  const data = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
  });
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/** 5. 取玩家档案（uuid + 名字） */
export async function fetchProfile(mcAccessToken) {
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  });
  if (res.status === 404) throw new Error('这个账号没有购买 Minecraft');
  if (!res.ok) throw new Error(`获取档案失败：HTTP ${res.status}`);
  return res.json();
}

/**
 * 完整登录流程。
 * onDeviceCode 拿到 { userCode, verificationUri, expiresIn } 后展示给用户。
 */
export async function loginWithDeviceCode({ clientId, onDeviceCode, onTick } = {}) {
  const device = await requestDeviceCode(clientId);
  onDeviceCode?.({
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    expiresIn: device.expires_in,
  });
  const token = await pollForToken(clientId, device.device_code, { onTick });
  const { xstsToken, uhs } = await xboxAuth(token.access_token);
  const mc = await minecraftLogin(xstsToken, uhs);
  const profile = await fetchProfile(mc.accessToken);
  const record = {
    clientId,
    name: profile.name,
    uuid: profile.id,
    accessToken: mc.accessToken,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (mc.expiresIn ?? 86_400) * 1000,
    updatedAt: new Date().toISOString(),
  };
  saveAuth(record);
  return record;
}
