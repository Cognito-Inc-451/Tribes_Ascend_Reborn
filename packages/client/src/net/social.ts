import { NODE_URL } from './node.js';

export interface ChatMsg { kind: 'global' | 'dm' | 'match' | 'system'; id: string; from: string; name: string; to?: string; text: string; ts: number; mine?: boolean }
export interface OnlinePlayer { id: string; name: string; status: string; serverWs?: string; serverName?: string; origin: string }
export interface Friend { id: string; name: string }

const FRIENDS_KEY = 'ascend-reborn:friends:v1';

/** Live link to this machine's node for friends, global chat and private messages. */
export class SocialClient {
  myId = '';
  online: OnlinePlayer[] = [];
  messages: ChatMsg[] = [];
  friends: Friend[] = [];
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private msgListeners = new Set<(m: ChatMsg) => void>();
  private name = '';
  private status: { status: string; serverWs?: string; serverName?: string } = { status: 'In lobby' };

  constructor() {
    try { this.friends = (JSON.parse(localStorage.getItem(FRIENDS_KEY) ?? '[]') as Friend[]).filter((f) => /^[0-9a-f]{16}$/.test(f.id)).slice(0, 200); } catch { this.friends = []; }
  }

  connect(name: string) {
    this.name = name;
    if (this.ws && this.ws.readyState <= 1) { this.send({ t: 'hello', name }); return; }
    const url = `${NODE_URL.replace(/^http/, 'ws')}/social`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { return; }
    this.ws = ws;
    ws.onopen = () => { this.send({ t: 'hello', name: this.name }); this.send({ t: 'status', ...this.status }); };
    ws.onclose = () => { this.ws = null; setTimeout(() => this.connect(this.name), 4000); };
    ws.onmessage = (ev) => {
      let m: { t: string; [k: string]: unknown };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === 'me') this.myId = String(m.id);
      else if (m.t === 'history') { this.messages = (m.msgs as ChatMsg[]).slice(-200); }
      else if (m.t === 'presence') this.online = m.players as OnlinePlayer[];
      else if (m.t === 'msg') this.push(m.msg as ChatMsg);
      else if (m.t === 'error') this.push({ kind: 'system', id: String(Math.random()), from: '', name: '', text: String(m.msg), ts: Date.now() });
      this.emit();
    };
  }

  get connected() { return this.ws?.readyState === 1; }

  push(m: ChatMsg) {
    this.messages.push(m);
    if (this.messages.length > 300) this.messages.shift();
    for (const l of this.msgListeners) l(m);
    this.emit();
  }

  private send(m: unknown) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }

  say(text: string) { if (text.trim()) this.send({ t: 'say', text: text.slice(0, 200) }); }
  dm(to: string, text: string) { if (text.trim()) this.send({ t: 'dm', to, text: text.slice(0, 200) }); }
  setStatus(status: string, serverWs?: string, serverName?: string) {
    this.status = { status, serverWs, serverName };
    this.send({ t: 'status', ...this.status });
  }

  isFriend(id: string) { return this.friends.some((f) => f.id === id); }
  addFriend(id: string, name: string) {
    if (!/^[0-9a-f]{16}$/.test(id) || id === this.myId || this.isFriend(id)) return;
    this.friends.push({ id, name: name.slice(0, 20) });
    this.saveFriends();
  }
  removeFriend(id: string) { this.friends = this.friends.filter((f) => f.id !== id); this.saveFriends(); }
  private saveFriends() { localStorage.setItem(FRIENDS_KEY, JSON.stringify(this.friends)); this.emit(); }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onMessage(fn: (m: ChatMsg) => void) { this.msgListeners.add(fn); return () => this.msgListeners.delete(fn); }
  private emit() { for (const l of this.listeners) l(); }

  nameOf(id: string) { return this.online.find((p) => p.id === id)?.name ?? this.friends.find((f) => f.id === id)?.name ?? id.slice(0, 6); }
}

export const social = new SocialClient();
