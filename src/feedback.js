import { createHash } from "node:crypto";
import WebSocket from "ws";

import { artifactClient, artifactId } from "./api.js";

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function signals(thread) {
  const entries = [];
  const activation = timestamp(thread.claude_activated_at);
  if (activation) entries.push({ key: `thread:${thread.id}`, at: activation, kind: "activation" });
  for (const comment of thread.comments) {
    const sent = timestamp(comment.to_claude_at);
    if (sent && comment.author?.role !== "assistant" && comment.author?.role !== "agent") {
      entries.push({ key: `comment:${thread.id}:${comment.id}`, at: sent, kind: "comment", comment_id: comment.id });
    }
  }
  return entries;
}

/** One artifact subscription. Comment reads happen on signals/reconnect, never an idle poll. */
export class ArtifactFeedbackWatch {
  constructor({ artifact, onFeedback, client = artifactClient, heartbeatMs = 25000, retryMs = 1000, maxFailures = 10, refreshLeadMs = 60000 }) {
    this.id = artifactId(artifact);
    this.url = `https://claude.ai/code/artifact/${this.id}`;
    this.client = client;
    this.onFeedback = onFeedback;
    this.heartbeatMs = heartbeatMs;
    this.retryMs = retryMs;
    this.maxFailures = maxFailures;
    this.refreshLeadMs = refreshLeadMs;
    this.abort = new AbortController();
    this.seen = new Map();
    this.state = "starting";
    this.failures = 0;
    this.scanFailures = 0;
    this.delivered = 0;
  }

  async start({ includeExisting = false } = {}) {
    try {
      // Baseline before connecting, then reconcile after open to cover the handshake gap.
      if (!includeExisting) {
        const data = await this.client.comments(this.id, this.abort.signal);
        for (const thread of data.threads) this.record(signals(thread));
      }
      await this.connect();
      await this.scan();
      return this.status();
    } catch (error) {
      this.stop();
      this.state = "failed";
      this.error = error.message;
      throw new Error(`Starting artifact feedback watch ${this.id}: ${error.message}`, { cause: error });
    }
  }

  status() {
    return {
      artifact_id: this.id,
      artifact_url: this.url,
      state: this.state,
      delivered: this.delivered,
      ...(this.lastEventAt ? { last_event_at: this.lastEventAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  record(entries) {
    for (const entry of entries) {
      const old = this.seen.get(entry.key);
      if (!old || Date.parse(entry.at) > Date.parse(old)) this.seen.set(entry.key, entry.at);
    }
  }

  async scan() {
    if (this.abort.signal.aborted) return;
    this.dirty = true;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      while (this.dirty && !this.abort.signal.aborted) {
        this.dirty = false;
        await this.deliverPending();
        const data = await this.client.comments(this.id, this.abort.signal);
        for (const thread of data.threads) {
          if (this.abort.signal.aborted) return;
          const entries = signals(thread);
          const fresh = entries.filter((entry) => !this.seen.has(entry.key) || Date.parse(entry.at) > Date.parse(this.seen.get(entry.key)));
          if (fresh.length && !thread.resolved_at) {
            const eventID = createHash("sha256").update(JSON.stringify([this.id, thread.id, fresh.map(({ key, at }) => [key, at]).sort()])).digest("hex");
            this.pending = { entries, event: {
              event_id: eventID,
              artifact_id: this.id,
              artifact_url: this.url,
              thread_id: thread.id,
              submissions: fresh.map(({ key, ...entry }) => entry),
              thread,
            } };
            await this.deliverPending();
          }
          // Delivery failures leave the checkpoint untouched, allowing safe retries.
          this.record(entries);
        }
        this.scanFailures = 0;
        if (this.state === "connected") this.error = undefined;
      }
    })();
    try {
      await this.scanning;
    } finally {
      this.scanning = undefined;
    }
  }

  async deliverPending() {
    if (!this.pending || this.abort.signal.aborted) return;
    await this.onFeedback(this.pending.event, this.abort.signal);
    if (this.abort.signal.aborted) return;
    this.record(this.pending.entries);
    this.pending = undefined;
    this.delivered++;
  }

  requestScan() {
    if (this.abort.signal.aborted) return;
    this.dirty = true;
    if (this.scanning) return;
    clearTimeout(this.scanTimer);
    void this.scan().catch((error) => {
      if (this.abort.signal.aborted) return;
      this.error = `Reading or delivering feedback: ${error.message}`;
      if (++this.scanFailures >= this.maxFailures) {
        this.stop();
        this.state = "failed";
        return;
      }
      this.scanTimer = setTimeout(() => this.requestScan(), Math.min(30000, this.retryMs * 2 ** (this.scanFailures - 1)));
      this.scanTimer.unref?.();
    });
  }

  async connect() {
    const boot = await this.client.boot(this.id, this.abort.signal);
    if (this.abort.signal.aborted) return;
    const expires = boot.subscriptionTokenExp ?? Number(boot.subscriptionToken.split(".")[0].split("|").at(-1));
    if (!Number.isFinite(expires) || expires * 1000 <= Date.now()) throw new Error("Claude issued an expired or invalid subscription token.");
    const socket = new WebSocket(this.client.socketUrl(this.id), ["frame-live.v1", boot.subscriptionToken], { handshakeTimeout: 15000, maxPayload: 1024 * 1024, followRedirects: false });
    this.socket = socket;
    let opened = false;
    let lastTraffic = Date.now();
    const cancel = () => socket.terminate();
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    socket.on("error", () => { /* close handles reconnection; never log a token-bearing handshake. */ });
    socket.on("message", (raw) => {
      if (this.abort.signal.aborted || this.socket !== socket) return;
      lastTraffic = Date.now();
      let event;
      try { event = JSON.parse(String(raw)); } catch { return; }
      if (event?.kind === "comment" || typeof event?.ver === "string") {
        this.lastEventAt = new Date().toISOString();
        this.requestScan();
      }
    });
    socket.on("close", () => {
      this.abort.signal.removeEventListener("abort", cancel);
      if (this.socket !== socket) return;
      this.clearConnectionTimers();
      this.socket = undefined;
      if (opened && !this.abort.signal.aborted) this.reconnect();
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new Error("Artifact WebSocket handshake failed.")));
      socket.once("close", () => reject(new Error("Artifact WebSocket closed before opening.")));
    });
    if (this.abort.signal.aborted) return;
    opened = true;
    this.state = "connected";
    this.error = undefined;
    // Match Claude Code's native watcher protocol, including listener presence.
    socket.send("ping");
    socket.send("hb");
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - lastTraffic > this.heartbeatMs * 2 + 5000) {
        socket.terminate();
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.refreshTimer = setTimeout(() => socket.close(1000, "refresh subscription"), Math.max(1000, expires * 1000 - Date.now() - this.refreshLeadMs));
    this.refreshTimer.unref?.();
    this.stableTimer = setTimeout(() => { this.failures = 0; }, 60000);
    this.stableTimer.unref?.();
  }

  reconnect() {
    if (this.abort.signal.aborted) return;
    this.state = "reconnecting";
    if (++this.failures >= this.maxFailures) {
      this.error = "Artifact stream repeatedly disconnected; call watch again to retry.";
      this.stop();
      this.state = "failed";
      return;
    }
    this.retryTimer = setTimeout(async () => {
      try {
        await this.connect();
        if (!this.abort.signal.aborted) this.requestScan();
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.error = `Reconnecting artifact stream: ${error.message}`;
        this.reconnect();
      }
    }, Math.min(30000, this.retryMs * 2 ** (this.failures - 1)));
    this.retryTimer.unref?.();
  }

  clearConnectionTimers() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.refreshTimer);
    clearTimeout(this.stableTimer);
  }

  stop() {
    this.abort.abort();
    this.clearConnectionTimers();
    clearTimeout(this.retryTimer);
    clearTimeout(this.scanTimer);
    this.socket?.terminate();
    this.socket = undefined;
    this.state = "stopped";
  }
}
