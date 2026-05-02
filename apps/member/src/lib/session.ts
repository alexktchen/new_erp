// Session helpers — 從 URL fragment 抓 token + LINE 個資，存入持久化儲存 (localStorage)
// 並透過 BroadcastChannel 通知其他視窗（如 PWA 視窗）

const TOKEN_KEY    = "member_jwt";
const STORE_KEY    = "member_store_id";
const MEMBER_KEY   = "member_id";
const LINE_UID_KEY = "line_user_id";
const LINE_NAME_KEY    = "line_name";
const LINE_PIC_KEY     = "line_picture";

const AUTH_CHANNEL_NAME = "member_auth_sync";

export type Session = {
  token: string;
  storeId: string;
  memberId: number | null;
  bound: boolean;
  lineUserId: string | null;
  lineName: string | null;
  linePicture: string | null;
};

/** 從 URL fragment 解出 session，存入儲存空間，並清理 URL。 */
export function consumeFragmentToSession(): Session | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  const p = new URLSearchParams(hash);
  const token = p.get("token");
  const store = p.get("store");
  if (!token || !store) return null;

  const memberId    = p.get("member_id") ? Number(p.get("member_id")) : null;
  const bound       = p.get("bound") === "1";
  const lineUserId  = p.get("line_user_id");
  const lineName    = p.get("line_name");
  const linePicture = p.get("line_picture");

  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(STORE_KEY, store);
  if (memberId)    localStorage.setItem(MEMBER_KEY, String(memberId));
  if (lineUserId)  localStorage.setItem(LINE_UID_KEY, lineUserId);
  if (lineName)    localStorage.setItem(LINE_NAME_KEY, lineName);
  if (linePicture) localStorage.setItem(LINE_PIC_KEY, linePicture);

  const session: Session = {
    token,
    storeId: store,
    memberId,
    bound,
    lineUserId,
    lineName,
    linePicture,
  };

  // 廣播給其他視窗 (例如原本開著的 PWA 視窗)
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    channel.postMessage({ type: "LOGIN_SUCCESS", session });
    channel.close();
  }

  // 清 fragment，避免 refresh / 分享外洩
  window.history.replaceState(null, "", window.location.pathname + window.location.search);

  return session;
}

/** 解 JWT payload 的 exp(秒)。失敗或沒 exp → null。不驗簽,只是給 client 判過期用 */
function jwtExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "==".slice(0, (4 - padded.length % 4) % 4));
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(TOKEN_KEY);
  const storeId = localStorage.getItem(STORE_KEY);
  if (!token || !storeId) return null;

  // 過期 / 解不出 exp 一律當沒登入,順手清掉避免下一輪又進來
  const exp = jwtExpSeconds(token);
  const now = Math.floor(Date.now() / 1000);
  if (exp === null || exp <= now) {
    clearSession();
    return null;
  }

  const mid = localStorage.getItem(MEMBER_KEY);
  return {
    token,
    storeId,
    memberId: mid ? Number(mid) : null,
    bound: !!mid,
    lineUserId:  localStorage.getItem(LINE_UID_KEY),
    lineName:    localStorage.getItem(LINE_NAME_KEY),
    linePicture: localStorage.getItem(LINE_PIC_KEY),
  };
}

export function clearSession() {
  if (typeof window === "undefined") return;
  [TOKEN_KEY, STORE_KEY, MEMBER_KEY, LINE_UID_KEY, LINE_NAME_KEY, LINE_PIC_KEY]
    .forEach((k) => localStorage.removeItem(k));
}

/** 監聽來自其他視窗的登入成功的訊息 (用於 PWA 視窗感應瀏覽器視窗的登入) */
export function listenForSession(callback: (s: Session) => void) {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return () => {};
  
  const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
  const handler = (e: MessageEvent) => {
    if (e.data?.type === "LOGIN_SUCCESS" && e.data.session) {
      callback(e.data.session);
    }
  };
  channel.addEventListener("message", handler);
  return () => {
    channel.removeEventListener("message", handler);
    channel.close();
  };
}
