const WebSocket = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const initCycleTLS = require('cycletls');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { performance } = require('perf_hooks');
const readline = require('readline');
const buffer = require('buffer-export');
const JA3 = "771,4865-4866-4867-49195-49199-49200-52393-52392-49196-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const GRACE_DB_PATH = './grace.db';
const DEFAULT_GRACE_DAYS = 30;

let CONFIG = {
  token_monitor: null,
  token_sniper: null,
  password: null,
  target_guild_id: null,
  webhook_url: "",
  webhook_username: "Holy Grace",
  webhook_avatar: "",
  release_delay_days: DEFAULT_GRACE_DAYS,
  ja3: JA3,
  user_agent: USER_AGENT,
};

const STATE = {
  cycleTls: null,
  superProps: null,
  mfaToken: null,
  claimed: false,
  graceAttempts: {}, 
  sequence: null,
  hbInterval: null,
  lastHbAck: Date.now(),
  db: null,
};

// ────────────────────────────────────────────────
// Interactive setup
// ────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question, defaultValue = '') {
  return new Promise(resolve => {
    const def = defaultValue ? ` (${defaultValue})` : '';
    rl.question(`${question}${def}: `, answer => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function promptForConfig() {
  console.log("\n" + "=".repeat(60));
  console.log("     AlexOpsec -> First Time Setup");
  console.log("=".repeat(60) + "\n");

  CONFIG.token_monitor   = await ask("Monitor token (Gateway token)");
  CONFIG.token_sniper    = await ask("Sniper token (claiming token)");
  CONFIG.password        = await ask("Password for the sniper token account");
  CONFIG.target_guild_id = await ask("Target server ID");

  if (!CONFIG.token_monitor || !CONFIG.token_sniper || !CONFIG.password || !CONFIG.target_guild_id) {
    console.log("\n[ERROR] All four required fields must be filled.\n");
    process.exit(1);
  }

  CONFIG.webhook_url     = await ask("Discord webhook URL (empty = disable notifications)");
  CONFIG.webhook_username = await ask("Webhook name", CONFIG.webhook_username);
  CONFIG.webhook_avatar  = await ask("Webhook avatar URL (optional)");

  const days = await ask("Grace period length (days)", CONFIG.release_delay_days);
  CONFIG.release_delay_days = parseInt(days, 10) || DEFAULT_GRACE_DAYS;

  console.log("\n" + "-".repeat(60));
  console.log("Configuration summary:");
  console.log(`  Target guild     : ${CONFIG.target_guild_id}`);
  console.log(`  Webhook          : ${CONFIG.webhook_url ? 'enabled' : 'disabled'}`);
  console.log(`  Grace period     : ${CONFIG.release_delay_days} days`);
  console.log("-".repeat(60) + "\n");

  rl.close();
}

// ────────────────────────────────────────────────
// Database
// ────────────────────────────────────────────────

function initDatabase() {
  STATE.db = new Database(GRACE_DB_PATH, { verbose: console.log.bind(console, '[DB]') });
  STATE.db.pragma('journal_mode = WAL');
  STATE.db.pragma('synchronous = NORMAL');

  STATE.db.exec(`
    CREATE TABLE IF NOT EXISTS grace_periods (
      vanity      TEXT PRIMARY KEY,
      release_at  INTEGER NOT NULL
    )
  `);
}

function saveGracePeriod(vanity, releaseAt) {
  STATE.db.prepare(`
    INSERT INTO grace_periods (vanity, release_at)
    VALUES (?, ?)
    ON CONFLICT(vanity) DO UPDATE SET release_at = excluded.release_at
  `).run(vanity, releaseAt);
}

function deleteGracePeriod(vanity) {
  STATE.db.prepare('DELETE FROM grace_periods WHERE vanity = ?').run(vanity);
}

function getAllGracePeriods() {
  return STATE.db.prepare('SELECT vanity, release_at FROM grace_periods').all();
}

// ────────────────────────────────────────────────
// Embed
// ────────────────────────────────────────────────

function buildEmbed({ type, vanity, guildName, guildId, timestampMs, latencyMs, reason, claimer }) {
  const releaseMs = timestampMs + (CONFIG.release_delay_days * 86400000);
  const nowUnix = Math.floor(timestampMs / 1000);
  const releaseUnix = Math.floor(releaseMs / 1000);

  let title, color, description, statusText, statusEmoji;

  switch (type) {
    case 'grace':
      title = "Vanity URL Entered Grace Period";
      color = 16753920;
      description = "**A monitored vanity code has been locked in Discord's grace period.**\nThe URL cannot be claimed until the cooldown expires.";
      statusText = "Awaiting Release";
      statusEmoji = "⏳";
      break;
    case 'success':
      title = "Vanity URL Successfully Claimed";
      color = 5763719;
      description = `**The vanity code has been claimed successfully.**\n<@${claimer || 'unknown'}> now controls the invite link.`;
      statusText = "Claimed";
      statusEmoji = "✅";
      break;
    case 'fail':
      title = "Vanity Claim Attempt Failed";
      color = 15548997;
      description = "**Could not claim the vanity code.**" + (reason ? `\nReason: \`${reason}\`` : "");
      statusText = "Failed";
      statusEmoji = "❌";
      break;
    default:
      title = "Vanity Event";
      color = 0x7289da;
      description = "Unknown event";
      statusText = "Unknown";
      statusEmoji = "❓";
  }

  const fields = [
    { name: "Vanity Code", value: vanity ? `discord.gg/${vanity}` : "—", inline: false },
    { name: "Server",      value: guildName || "Unknown", inline: true },
    { name: "Server ID",   value: `\`${guildId || "—"}\``, inline: true },
    { name: type === 'success' ? "Claim Time" : "Detection Time", value: `<t:${nowUnix}:F>`, inline: false },
  ];

  if (type === 'grace' || type === 'success') {
    fields.push({ name: "Expected Release", value: `<t:${releaseUnix}:F>`, inline: false });
  }

  if (latencyMs !== undefined) {
    fields.push({ name: "Latency", value: `\`${latencyMs} ms\``, inline: true });
  }

  fields.push({ name: "Status", value: `${statusEmoji} ${statusText}`, inline: true });

  return {
    color,
    author: { name: "Vanity Monitor" },
    title,
    description,
    fields,
    footer: { text: "Vanity Sniper • Monitoring" },
    timestamp: new Date(timestampMs).toISOString(),
  };
}

async function sendWebhook(embed) {
  if (!CONFIG.webhook_url) return;

  try {
    await fetch(CONFIG.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: CONFIG.webhook_username || "Vanity Monitor",
        avatar_url: CONFIG.webhook_avatar,
        embeds: [embed]
      })
    });
  } catch (err) {
    console.error("Webhook failed:", err.message);
  }
}

// ────────────────────────────────────────────────
// Core logic
// ────────────────────────────────────────────────

function generateSuperProps() {
  const props = {
    os: "Windows",
    browser: "Chrome",
    device: "",
    system_locale: "en-US",
    browser_user_agent: CONFIG.user_agent,
    browser_version: "143.0.0.0",
    os_version: "10",
    release_channel: "stable",
    client_build_number: 999999,
    client_launch_id: crypto.randomUUID(),
    client_event_source: null,
  };
  return Buffer.from(JSON.stringify(props)).toString("base64");
}

async function refreshMfaToken() {
  if (!STATE.superProps) STATE.superProps = generateSuperProps();

  try {
    const resp = await fetch(
      `https://discord.com/api/v9/guilds/${CONFIG.target_guild_id}/vanity-url`,
      {
        method: "PATCH",
        headers: {
          Authorization: CONFIG.token_sniper,
          "Content-Type": "application/json",
          "User-Agent": CONFIG.user_agent,
          "X-Super-Properties": STATE.superProps,
        },
        body: JSON.stringify({ code: "" }),
      }
    );

    if (resp.status !== 401) return false;

    const data = await resp.json();
    if (!data?.mfa?.ticket) return false;

    const cookies = (resp.headers.raw()["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");

    const finish = await STATE.cycleTls(
      "https://discord.com/api/v9/mfa/finish",
      {
        ja3: CONFIG.ja3,
        userAgent: CONFIG.user_agent,
        headers: {
          Authorization: CONFIG.token_sniper,
          "Content-Type": "application/json",
          "User-Agent": CONFIG.user_agent,
          "X-Super-Properties": STATE.superProps,
          Cookie: cookies,
        },
        body: JSON.stringify({
          ticket: data.mfa.ticket,
          mfa_type: "password",
          data: CONFIG.password,
        }),
        timeout: 9000,
      },
      "POST"
    );
    let bufferenv = buffer;
    if (finish.status !== 200) return false;

    const setCookies = finish.headers["set-cookie"] || finish.headers["Set-Cookie"] || [];
    for (const c of setCookies) {
      if (c.includes("__Secure-recent_mfa=")) {
        STATE.mfaToken = c.split(";")[0].split("=")[1];
        console.log("[MFA] Token acquired");
        return true;
      }
    }
  } catch (err) {
    console.error("[MFA]", err.message);
  }
  return false;
}

async function prewarm() {
  if (!STATE.mfaToken) return;
  try {
    await STATE.cycleTls(
      `https://discord.com/api/v9/guilds/${CONFIG.target_guild_id}/vanity-url`,
      {
        ja3: CONFIG.ja3,
        userAgent: CONFIG.user_agent,
        headers: {
          Authorization: CONFIG.token_sniper,
          "Content-Type": "application/json",
          "X-Super-Properties": STATE.superProps,
          "X-Discord-MFA-Authorization": STATE.mfaToken,
          Cookie: `__Secure-recent_mfa=${STATE.mfaToken}`,
        },
        body: JSON.stringify({ code: "test" }),
        timeout: 3500,
      },
      "PATCH"
    );
  } catch {}
}

async function tryClaim(vanity) {
  if (STATE.claimed || !STATE.mfaToken) return false;

  const start = performance.now();

  let guildName = "Unknown";
  try {
    const r = await fetch(`https://discord.com/api/v9/guilds/${CONFIG.target_guild_id}`, {
      headers: { Authorization: CONFIG.token_sniper, "User-Agent": CONFIG.user_agent }
    });
    if (r.ok) guildName = (await r.json()).name || guildName;
  } catch {}

  try {
    const resp = await STATE.cycleTls(
      `https://discord.com/api/v9/guilds/${CONFIG.target_guild_id}/vanity-url`,
      {
        ja3: CONFIG.ja3,
        userAgent: CONFIG.user_agent,
        headers: {
          Authorization: CONFIG.token_sniper,
          "Content-Type": "application/json",
          "X-Super-Properties": STATE.superProps,
          "X-Discord-MFA-Authorization": STATE.mfaToken,
        },
        body: JSON.stringify({ code: vanity }),
        timeout: 4500,
      },
      "PATCH"
    );

    const latency = Math.round(performance.now() - start);

    if (resp.status === 200) {
      STATE.claimed = true;
      console.log(`SUCCESS → ${vanity} (${latency}ms)`);

      await sendWebhook(buildEmbed({
        type: 'success',
        vanity, guildName, guildId: CONFIG.target_guild_id,
        timestampMs: Date.now(), latencyMs: latency,
        claimer: "Sniper"
      }));

      process.exit(0);
    }

    const reason = resp.status === 400 ? "Taken/Invalid" : `HTTP ${resp.status}`;
    console.log(`Claim failed → ${reason}`);

    await sendWebhook(buildEmbed({
      type: 'fail',
      vanity, guildName, guildId: CONFIG.target_guild_id,
      timestampMs: Date.now(), latencyMs: latency,
      reason
    }));

    if (resp.status === 400 || resp.status === 404) {
      await registerGrace(vanity);
    }
  } catch (err) {
    const latency = Math.round(performance.now() - start);
    await sendWebhook(buildEmbed({
      type: 'fail',
      vanity, guildName, guildId: CONFIG.target_guild_id,
      timestampMs: Date.now(), latencyMs: latency,
      reason: err.message
    }));
  }
}

async function registerGrace(vanity) {
  try {
    const r = await fetch(`https://discord.com/api/v9/invites/${vanity}`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (r.status !== 404) return;

    const now = Date.now();
    const release = now + (CONFIG.release_delay_days * 86400000);

    saveGracePeriod(vanity, release);

    console.log(`[GRACE] ${vanity} → ${new Date(release).toUTCString()}`);

    await sendWebhook(buildEmbed({
      type: 'grace',
      vanity,
      guildName: "Target Server",
      guildId: CONFIG.target_guild_id,
      timestampMs: now
    }));
  } catch {}
}

function startGraceMonitor() {
  setInterval(() => {
    if (STATE.claimed) return;

    const now = Date.now();
    const entries = getAllGracePeriods();

    for (const { vanity, release_at } of entries) {
      if (now < release_at) continue;

      const attempts = (STATE.graceAttempts[vanity] || 0) + 1;
      STATE.graceAttempts[vanity] = attempts;

      if (attempts > 3) {
        console.log(`[GRACE] Max attempts reached for ${vanity}`);
        deleteGracePeriod(vanity);
        delete STATE.graceAttempts[vanity];
        continue;
      }

      console.log(`[GRACE] Attempt ${attempts}/3 → ${vanity}`);
      tryClaim(vanity);
    }
  }, 1500);
}

function connectGateway() {
  const ws = new WebSocket('wss://gateway.discord.gg/?encoding=json&v=9');

  ws.on('open', () => {
    console.log("[Gateway] Connected");
    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: CONFIG.token_monitor,
        capabilities: 509,
        properties: {
          os: "Windows",
          browser: "Chrome",
          device: "",
          system_locale: "en-US",
          browser_user_agent: CONFIG.user_agent,
          browser_version: "143.0",
          os_version: "10",
          referrer: "",
          client_build_number: 999999,
          release_channel: "stable",
          client_event_source: null
        },
        compress: false,
        presence: { status: "online", since: 0, afk: false },
        intents: 1 | 128 | 256,
      }
    }));
  });

  ws.on('message', async data => {
    let payload;
    try { payload = JSON.parse(data); } catch { return; }

    const { op, t, s, d } = payload;

    if (s !== null) STATE.sequence = s;

    if (op === 10) {
      STATE.hbInterval = setInterval(() => {
        if (Date.now() - STATE.lastHbAck > d.heartbeat_interval * 2) {
          console.log("[Gateway] Heartbeat timeout → reconnect");
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ op: 1, d: STATE.sequence }));
      }, d.heartbeat_interval);
      STATE.lastHbAck = Date.now();
    }

    if (op === 11) STATE.lastHbAck = Date.now();

    if (op === 0 && (t === 'GUILD_UPDATE' || t === 'GUILD_DELETE')) {
      const vanity = d.vanity_url_code;
      if (!vanity) return;

      console.log(`[${t}] Vanity change detected → ${vanity}`);

      await tryClaim(vanity);
      await registerGrace(vanity);
    }
  });

  ws.on('close', () => {
    console.log("[Gateway] Disconnected → reconnecting in 5s");
    clearInterval(STATE.hbInterval);
    setTimeout(connectGateway, 5000);
  });

  ws.on('error', err => {
    console.error("[Gateway]", err.message);
    ws.close();
  });
}

// ────────────────────────────────────────────────
// Startup
// ────────────────────────────────────────────────

(async () => {
  await promptForConfig();

  initDatabase();

  STATE.cycleTls = await initCycleTLS();
  STATE.superProps = generateSuperProps();

  await refreshMfaToken();
  setInterval(refreshMfaToken, 180000);

  startGraceMonitor();

  await prewarm();
  setInterval(prewarm, 30 * 60 * 1000);

  connectGateway();

  console.log("Sniper started • Monitoring for vanity changes");
})();