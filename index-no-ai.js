import "dotenv/config";
import { chromium } from "playwright";
import fs from "fs";

const AUTH_FILE = "./auth.json";
const ANALYZED_PROFILES_FILE = "./noai-analyzed-profiles.json";
const LOGIN_CHECK_URL = "https://live-backstage.tiktok.com/portal/anchor/list";
const TARGET_URL = "https://live-backstage.tiktok.com/portal/anchor/scout-creators?tab=2&type=2";
const INCORPORATION_WINDOW_MINUTES = 7 * 24 * 60;
const NO_AI_BUILD_TAG = "index-no-ai.js build 2026-04-18.1";

const MONTHS_ES = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

function normalizeText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeProfileCacheKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\s+/g, "");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadAnalyzedProfilesCache() {
  try {
    if (!fs.existsSync(ANALYZED_PROFILES_FILE)) {
      return new Set();
    }

    const raw = fs.readFileSync(ANALYZED_PROFILES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.profiles)
        ? parsed.profiles
        : [];

    return new Set(
      arr
        .map((v) => normalizeProfileCacheKey(v))
        .filter(Boolean)
    );
  } catch (err) {
    console.warn(`[NO-AI] No se pudo leer ${ANALYZED_PROFILES_FILE}: ${err.message}`);
    return new Set();
  }
}

function saveAnalyzedProfilesCache(cacheSet) {
  try {
    const profiles = Array.from(cacheSet)
      .map((v) => normalizeProfileCacheKey(v))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    fs.writeFileSync(
      ANALYZED_PROFILES_FILE,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          count: profiles.length,
          profiles
        },
        null,
        2
      )
    );
  } catch (err) {
    console.warn(`[NO-AI] No se pudo guardar ${ANALYZED_PROFILES_FILE}: ${err.message}`);
  }
}

function safeLocalDate(year, monthIndex, day) {
  const d = new Date(year, monthIndex, day, 0, 0, 0, 0);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== monthIndex ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

function parseInputDate(rawInput) {
  const input = String(rawInput || "").trim();
  if (!input) return null;

  let match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    return safeLocalDate(year, month, day);
  }

  match = input.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    return safeLocalDate(year, month, day);
  }

  match = normalizeText(input).match(/^(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?$/);
  if (match) {
    const day = Number(match[1]);
    const month = MONTHS_ES[match[2]];
    const year = match[3] ? Number(match[3]) : new Date().getFullYear();
    if (month === undefined) return null;
    return safeLocalDate(year, month, day);
  }

  match = normalizeText(input).match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
  if (match) {
    const day = Number(match[1]);
    const month = MONTHS_ES[match[2]];
    const year = match[3] ? Number(match[3]) : new Date().getFullYear();
    if (month === undefined) return null;
    return safeLocalDate(year, month, day);
  }

  return null;
}

function getDateInputFromArgs() {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--fecha=")) return arg.slice("--fecha=".length).trim();
    if (arg === "--fecha" || arg === "-f") {
      const rest = [];
      for (let j = i + 1; j < args.length; j += 1) {
        if (args[j].startsWith("-") && rest.length > 0) break;
        if (args[j].startsWith("-") && rest.length === 0) break;
        rest.push(args[j]);
      }
      return rest.join(" ").trim();
    }
  }

  const positional = args.filter((a) => !a.startsWith("-"));
  return positional.join(" ").trim();
}

function formatMinutesAsDhM(totalMinutes) {
  const safe = Math.max(0, Math.floor(totalMinutes));
  const days = Math.floor(safe / 1440);
  const hours = Math.floor((safe % 1440) / 60);
  const minutes = safe % 60;
  return `${days}d ${hours}h ${minutes}m`;
}

function formatLocalDateTime(date) {
  return date.toLocaleString("es-CO", { hour12: false });
}

function parseIncorporationToMinutes(text) {
  if (!text) return NaN;
  const raw = normalizeText(text);
  if (!raw) return NaN;

  let totalMinutes = 0;
  const unitRegex = /(\d+(?:[\.,]\d+)?)\s*(d|dia|dias|day|days|h|hr|hrs|hora|horas|m|min|mins|minuto|minutos|s|sec|secs|seg|segs|segundo|segundos)\b/g;
  const matches = Array.from(raw.matchAll(unitRegex));

  for (const item of matches) {
    const value = Number(item[1].replace(",", "."));
    const unit = item[2];
    if (!Number.isFinite(value)) continue;

    if (["d", "dia", "dias", "day", "days"].includes(unit)) totalMinutes += value * 24 * 60;
    else if (["h", "hr", "hrs", "hora", "horas"].includes(unit)) totalMinutes += value * 60;
    else if (["m", "min", "mins", "minuto", "minutos"].includes(unit)) totalMinutes += value;
    else if (["s", "sec", "secs", "seg", "segs", "segundo", "segundos"].includes(unit)) totalMinutes += value / 60;
  }

  if (totalMinutes > 0) return totalMinutes;

  const hhmmss = raw.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hhmmss) {
    const h = Number(hhmmss[1]);
    const m = Number(hhmmss[2]);
    const s = Number(hhmmss[3] || 0);
    return h * 60 + m + s / 60;
  }

  return NaN;
}

function getApplicationDateFromRemaining(referenceNow, remainingMinutes) {
  if (!Number.isFinite(remainingMinutes)) return null;
  const clampedRemaining = Math.min(
    INCORPORATION_WINDOW_MINUTES,
    Math.max(0, remainingMinutes)
  );
  const elapsedMinutes = INCORPORATION_WINDOW_MINUTES - clampedRemaining;
  return new Date(referenceNow.getTime() - elapsedMinutes * 60000);
}

async function clickFirstVisible(page, selectors, clickOptions = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      try {
        await candidate.click(clickOptions);
        return true;
      } catch (_) {
        // continuar
      }
    }
  }
  return false;
}

async function waitForCreatorsTable(page) {
  await page.waitForSelector("table, [role='grid'], [role='table']", { timeout: 45000 });
  await page.waitForTimeout(1200);
}

async function setItemsPerPageTo100(page) {
  console.log("Configurando Elementos por página en 100...");

  let isAlready100 = await page
    .locator("text=/Elementos por página\\s*:\\s*100/i")
    .first()
    .isVisible()
    .catch(() => false);

  if (isAlready100) {
    console.log("Elementos por página ya está en 100.");
    return;
  }

  const opened = await clickFirstVisible(page, [
    "text=/Elementos por página/i",
    "[aria-label*='Elementos por página' i]",
    "[title*='Elementos por página' i]"
  ]);

  if (opened) {
    await page.waitForTimeout(500);
    await clickFirstVisible(page, [
      "text=/Elementos por página\\s*:\\s*100/i",
      "text=/^100$/"
    ]);
    await page.waitForTimeout(1500);
  }

  isAlready100 = await page
    .locator("text=/Elementos por página\\s*:\\s*100/i")
    .first()
    .isVisible()
    .catch(() => false);

  if (isAlready100) {
    console.log("Elementos por página configurado en 100.");
  } else {
    console.warn("No pude confirmar visualmente que quedó en 100. Continuando...");
  }
}

async function clickProfileRow(page, rowIndex, nameHint = "") {
  const context = page.context();
  const beforeCount = context.pages().length;
  const rowSelector =
    "table tbody tr, [role='rowgroup'] [role='row'], .semi-table-tbody .semi-table-row, .semi-table-row";
  const normalizedNameHint = normalizeProfileId(nameHint);

  const rows = page.locator(rowSelector);
  const rowCount = await rows.count().catch(() => 0);
  if (!rowCount) {
    return {
      success: false,
      targetPage: page,
      openedNewTab: false,
      clickMeta: { method: "no-rows", matchedBy: "no-rows", resolvedName: "" }
    };
  }

  let targetRow = null;
  let resolvedName = "";
  let resolvedMethod = "";
  let matchedBy = "none";

  const matchedByUsername = await page.evaluate((selector, rawName) => {
    const normalize = (v) =>
      String(v || "")
        .trim()
        .toLowerCase()
        .replace(/^@/, "")
        .replace(/\s+/g, "");
    const target = normalize(rawName);
    if (!target) return null;

    const rows = Array.from(document.querySelectorAll(selector));
    const readUsernameCandidates = (row) => {
      const selectors = [
        "[data-e2e-tag='common_anchorInfo_username'] .anchorInfo-clickable-QO4KoS",
        "[data-e2e-tag='common_anchorInfo_username'] p span",
        "[data-e2e-tag='common_anchorInfo_username'] p",
        "[data-e2e-tag='common_anchorInfo_username'] span",
        ".anchorDetail-DFxF7v .lineInfo-toSRud span p span",
        ".anchorDetail-DFxF7v .lineInfo-toSRud p span",
        ".anchorDetail-DFxF7v .lineInfo-toSRud span",
      ];

      const found = [];
      const seen = new Set();

      for (const selectorPart of selectors) {
        const nodes = Array.from(row.querySelectorAll(selectorPart));
        for (const node of nodes) {
          const text = (node.textContent || "").trim();
          if (!text) continue;
          if (/^name$/i.test(text)) continue;
          if (!/[a-z0-9._@-]/i.test(text)) continue;
          const key = normalize(text);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          found.push(text);
        }
      }

      return found;
    };

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const usernames = readUsernameCandidates(row);
      const exact = usernames.find((username) => normalize(username) === target);
      if (exact) {
        return {
          rowKey: row.getAttribute("data-row-key") || "",
          rowPos: i,
          username: exact,
          matchedBy: "exact-text"
        };
      }
    }

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const usernames = readUsernameCandidates(row);
      const partial = usernames.find((username) => {
        const normalizedUsername = normalize(username);
        return (
          normalizedUsername &&
          (normalizedUsername.includes(target) || target.includes(normalizedUsername))
        );
      });
      if (partial) {
        return {
          rowKey: row.getAttribute("data-row-key") || "",
          rowPos: i,
          username: partial,
          matchedBy: "contains-text"
        };
      }
    }
    return null;
  }, rowSelector, nameHint).catch(() => null);

  if (matchedByUsername?.rowKey) {
    const byRowKey = page.locator(`${rowSelector}[data-row-key="${matchedByUsername.rowKey}"]`).first();
    if ((await byRowKey.count().catch(() => 0)) > 0) {
      targetRow = byRowKey;
      resolvedName = matchedByUsername.username || "";
      resolvedMethod =
        matchedByUsername.matchedBy === "contains-text"
          ? "username-contains-rowkey"
          : "username-exact-rowkey";
      matchedBy =
        matchedByUsername.matchedBy === "contains-text"
          ? "username-contains-text-rowkey"
          : "username-exact-text-rowkey";
    }
  }

  if (!targetRow && Number.isFinite(matchedByUsername?.rowPos) && matchedByUsername.rowPos >= 0 && matchedByUsername.rowPos < rowCount) {
    targetRow = rows.nth(matchedByUsername.rowPos);
    resolvedName = matchedByUsername.username || "";
    resolvedMethod =
      matchedByUsername.matchedBy === "contains-text"
        ? "username-contains-rowpos"
        : "username-exact-rowpos";
    matchedBy =
      matchedByUsername.matchedBy === "contains-text"
        ? "username-contains-text-rowpos"
        : "username-exact-text-rowpos";
  }

  if (!targetRow && normalizedNameHint) {
    const byName = rows.filter({ hasText: nameHint });
    if ((await byName.count().catch(() => 0)) > 0) {
      targetRow = byName.first();
      resolvedMethod = "namehint-partial";
      matchedBy = "namehint-partial";
    }
  }

  if (!targetRow && Number.isFinite(rowIndex) && rowIndex >= 0 && rowIndex < rowCount) {
    targetRow = rows.nth(rowIndex);
    resolvedMethod = "row-index";
    matchedBy = "row-index";
  }

  if (!targetRow) {
    return {
      success: false,
      targetPage: page,
      openedNewTab: false,
      clickMeta: { method: "row-not-found", matchedBy: "row-not-found", resolvedName: "" }
    };
  }

  await targetRow.scrollIntoViewIfNeeded().catch(() => null);
  if (!resolvedName) {
    resolvedName = await targetRow
      .innerText()
      .then((txt) => (txt || "").toString().trim().split("\n").map((s) => s.trim()).find(Boolean) || "")
      .catch(() => "");
  }

  const detectOpenAfterClick = async () => {
    await page.waitForTimeout(1000).catch(() => null);

    const pagesAfter = context.pages();
    if (pagesAfter.length > beforeCount) {
      const targetPage = pagesAfter[pagesAfter.length - 1];
      await targetPage.bringToFront().catch(() => null);
      await targetPage.waitForTimeout(1200).catch(() => null);
      return { opened: true, targetPage, openedNewTab: true };
    }

    const openedId = normalizeProfileId(await getOpenedProfileIdFromDetail(page).catch(() => ""));
    if (openedId) {
      return { opened: true, targetPage: page, openedNewTab: false };
    }

    const detailVisible = await page
      .locator("text=/Creator lead details/i")
      .first()
      .isVisible()
      .catch(() => false);
    if (detailVisible) {
      return { opened: true, targetPage: page, openedNewTab: false };
    }

    return { opened: false, targetPage: page, openedNewTab: false };
  };

  const expectedUsername = normalizeProfileId(resolvedName || nameHint);
  const usernameFallbackSelector =
    "[data-e2e-tag='common_anchorInfo_username'] .anchorInfo-clickable-QO4KoS:not([aria-label*='copy' i]):not([title*='copy' i]):not([class*='copy']), [data-e2e-tag='common_anchorInfo_username'] p:not([aria-label*='copy' i]):not([title*='copy' i]):not([class*='copy']), [data-e2e-tag='common_anchorInfo_username'] span:not([aria-label*='copy' i]):not([title*='copy' i]):not([class*='copy'])";
  let usernameClickable = targetRow.locator(usernameFallbackSelector).first();
  let usernameClickKind = "username";

  if (expectedUsername) {
    const exactUsernamePattern = new RegExp(`^\\s*@?${escapeRegExp(expectedUsername)}\\s*$`, "i");
    const usernameByExactText = targetRow
      .locator(
        "[data-e2e-tag='common_anchorInfo_username'] :is(p, span, div):not([aria-label*='copy' i]):not([title*='copy' i]):not([class*='copy']):not(:has([aria-label*='copy' i], [title*='copy' i], [class*='copy']))"
      )
      .filter({ hasText: exactUsernamePattern })
      .first();
    if ((await usernameByExactText.count().catch(() => 0)) > 0) {
      usernameClickable = usernameByExactText;
      usernameClickKind = "username-text";
    }
  }

  const avatarClickable = targetRow.locator("[data-id='anchor-info-avatar'], img, [class*='avatar'], [class*='Avatar']").first();
  const rowCellClickable = targetRow.locator("td[aria-colindex='1'], td, [role='cell'], .semi-table-row-cell").first();

  let clickLocator = usernameClickable;
  let clickMethod = `${resolvedMethod || "unknown"}->${usernameClickKind}`;
  if ((await clickLocator.count().catch(() => 0)) === 0) {
    clickLocator = avatarClickable;
    clickMethod = `${resolvedMethod || "unknown"}->avatar`;
  }
  if ((await clickLocator.count().catch(() => 0)) === 0) {
    clickLocator = rowCellClickable;
    clickMethod = `${resolvedMethod || "unknown"}->cell`;
  }
  if ((await clickLocator.count().catch(() => 0)) === 0) {
    clickLocator = targetRow;
    clickMethod = `${resolvedMethod || "unknown"}->row`;
  }

  const clickOptions = { timeout: 2500, force: true };
  if (clickMethod.includes("->username")) {
    const box = await clickLocator.boundingBox().catch(() => null);
    if (box?.width && box?.height) {
      clickOptions.position = {
        x: Math.max(3, Math.min(18, Math.floor(box.width * 0.15))),
        y: Math.max(3, Math.min(Math.floor(box.height / 2), Math.floor(box.height - 3)))
      };
      clickMethod = `${clickMethod}-left-edge`;
    }
  }

  const clicked = await clickLocator
    .click(clickOptions)
    .then(() => true)
    .catch(() => false);

  if (!clicked) {
    return {
      success: false,
      targetPage: page,
      openedNewTab: false,
      clickMeta: { method: `${clickMethod}-click-failed`, matchedBy, resolvedName }
    };
  }

  const openedState = await detectOpenAfterClick();
  if (openedState.opened) {
    return {
      success: true,
      targetPage: openedState.targetPage,
      openedNewTab: openedState.openedNewTab,
      clickMeta: { method: clickMethod, matchedBy, resolvedName }
    };
  }

  if (clickMethod.includes("->username")) {
    const retries = [
      { locator: avatarClickable, suffix: "retry-avatar" },
      { locator: rowCellClickable, suffix: "retry-cell" },
      { locator: targetRow, suffix: "retry-row" }
    ];

    for (const retry of retries) {
      const available = await retry.locator.count().catch(() => 0);
      if (!available) continue;

      const retryClicked = await retry.locator
        .click({ timeout: 2000, force: true })
        .then(() => true)
        .catch(() => false);
      if (!retryClicked) continue;

      const retryOpened = await detectOpenAfterClick();
      if (retryOpened.opened) {
        return {
          success: true,
          targetPage: retryOpened.targetPage,
          openedNewTab: retryOpened.openedNewTab,
          clickMeta: { method: `${clickMethod}|${retry.suffix}`, matchedBy, resolvedName }
        };
      }
    }
  }

  return {
    success: false,
    targetPage: page,
    openedNewTab: false,
    clickMeta: { method: `${resolvedMethod || "unknown"}-clicked-but-not-opened`, matchedBy: matchedBy || "unknown", resolvedName }
  };
}

async function detectPhoneInProfile(targetPage, profileName = "") {
  await targetPage.waitForTimeout(400).catch(() => null);

  await targetPage.evaluate(() => {
    const normalize = (v) => (v || "").toString().trim();
    const unique = (list) => Array.from(new Set(list.filter(Boolean)));
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return Boolean(el.offsetParent) || style.position === "fixed";
    };

    const headingEl = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, div, span, p"))
      .find((el) => /creator lead details/i.test(normalize(el.textContent)));

    const rootCandidates = unique([
      headingEl?.closest(
        "[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-drawer-wrap, .semi-modal-content, .semi-modal, .semi-modal-wrap, aside, section, article, div"
      ),
      ...Array.from(document.querySelectorAll("[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-modal-content, .semi-modal, .semi-drawer-wrap, .semi-modal-wrap"))
    ])
      .filter((el) => isVisible(el))
      .map((el) => {
        const txt = normalize(el.innerText || el.textContent);
        let score = 0;
        if (/creator lead details/i.test(txt)) score += 100;
        if (/\bapplied\b/i.test(txt)) score += 20;
        if (/@[a-z0-9._]{3,}/i.test(txt)) score += 15;
        if (txt.length < 50) score -= 20;
        if (txt.length > 20000) score -= 20;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);

    const root = rootCandidates[0]?.el;
    if (!root) return;

    const candidates = [];
    const pushAll = (selector) => root.querySelectorAll(selector).forEach((el) => candidates.push(el));
    pushAll("[aria-label*='eye' i]");
    pushAll("[title*='eye' i]");
    pushAll("[aria-label*='show' i]");
    pushAll("[title*='show' i]");
    pushAll("[class*='eye' i]");
    pushAll("svg[class*='eye' i], i[class*='eye' i], span[class*='eye' i]");

    const seen = new Set();
    for (const raw of candidates.slice(0, 12)) {
      const el = raw.closest("button, [role='button'], a, span, div") || raw;
      if (!el || seen.has(el) || !isVisible(el)) continue;
      seen.add(el);
      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } catch (_) {
        // continue
      }
    }
  }).catch(() => null);

  await targetPage.waitForTimeout(1000).catch(() => null);

  return targetPage.evaluate((nameHint) => {
    const normalize = (v) => (v || "").toString().trim();
    const unique = (list) => Array.from(new Set(list.filter(Boolean)));
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return Boolean(el.offsetParent) || style.position === "fixed";
    };
    const hasEmailLike = (line) => /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(line);
    const lineHasUserHandle = (line) => /(^|\s)@?user\d{6,}/i.test(line);
    const lineHasPhoneContext = (line) =>
      /(phone|telefono|teléfono|celular|whatsapp|contact|call|llamar)/i.test(line);
    const normalizedNameHint = normalize(nameHint).toLowerCase();
    const hintedNumbers = new Set(
      (normalizedNameHint.match(/\d{6,}/g) || []).map((d) => d.trim())
    );

    const headingEl = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, div, span, p"))
      .find((el) => /creator lead details/i.test(normalize(el.textContent)));

    const rootCandidates = unique([
      headingEl?.closest(
        "[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-drawer-wrap, .semi-modal-content, .semi-modal, .semi-modal-wrap, aside, section, article, div"
      ),
      ...Array.from(document.querySelectorAll("[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-modal-content, .semi-modal, .semi-drawer-wrap, .semi-modal-wrap"))
    ])
      .filter((el) => isVisible(el))
      .map((el) => {
        const txt = normalize(el.innerText || el.textContent);
        let score = 0;
        if (/creator lead details/i.test(txt)) score += 100;
        if (/\bapplied\b/i.test(txt)) score += 20;
        if (/@[a-z0-9._]{3,}/i.test(txt)) score += 10;
        return { el, txt, score };
      })
      .sort((a, b) => b.score - a.score);

    const root = rootCandidates[0]?.el;
    if (!root) {
      return { hasPhone: false, phones: [], phone: "", error: "No se encontró panel de detalle" };
    }

    const scopeText = normalize(root.innerText || root.textContent);
    const lines = scopeText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 400);

    const candidates = [];
    for (const line of lines) {
      const matches = line.match(/(?:\+?\d[\d\s().*\-]{6,}\d)/g) || [];
      for (const m of matches) candidates.push({ raw: m, line });
    }

    const scopeHasPhoneContext = lineHasPhoneContext(scopeText);
    const normalized = Array.from(
      new Set(
        candidates
          .map(({ raw, line }) => {
            if (hasEmailLike(line) || lineHasUserHandle(line)) return "";

            const compact = raw.replace(/[^\d+*]/g, "");
            if (!compact) return "";

            const digits = compact.replace(/\D/g, "");
            if (digits.length < 8 || digits.length > 13) return "";
            if (hintedNumbers.has(digits)) return "";
            if (normalizedNameHint && normalize(line).toLowerCase().includes(normalizedNameHint)) return "";

            if (compact.includes("*")) {
              return compact.startsWith("+") ? compact : `+${compact.replace(/^\+/, "")}`;
            }

            const hasPlusOrSeparators = raw.includes("+") || /[().\s-]/.test(raw);
            if (!hasPlusOrSeparators) {
              if (digits.length < 10 || digits.length > 11) return "";
              if (!lineHasPhoneContext(line) && !scopeHasPhoneContext) return "";
            }

            return `+${digits}`;
          })
          .filter(Boolean)
      )
    ).slice(0, 2);

    return {
      hasPhone: normalized.length > 0,
      phones: normalized,
      phone: normalized[0] || ""
    };
  }, profileName);
}

function normalizeProfileId(value) {
  return normalizeProfileCacheKey(value);
}

function profileSnapshotMatchesExpected(expectedName, snapshot) {
  const expected = normalizeProfileId(expectedName);
  if (!expected) return true;

  const openedId = normalizeProfileId(snapshot?.openedId || "");
  const titleLine = String(snapshot?.titleLine || "").toLowerCase();
  const signature = String(snapshot?.signature || "").toLowerCase();

  if (openedId) {
    if (openedId === expected) return true;
    if (openedId.includes(expected) || expected.includes(openedId)) return true;
  }

  if (titleLine.includes(`@${expected}`) || titleLine.includes(expected)) return true;
  if (signature.includes(`@${expected}`) || signature.includes(expected)) return true;

  return false;
}

async function getOpenedProfileIdFromDetail(targetPage) {
  return targetPage.evaluate(() => {
    const normalize = (v) => (v || "").toString().trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return Boolean(el.offsetParent) || style.position === "fixed";
    };
    const hasEmailLike = (line) => /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(line);
    const unique = (list) => Array.from(new Set(list.filter(Boolean)));

    const headingEl = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, div, span, p"))
      .find((el) => /creator lead details/i.test(normalize(el.textContent)));

    const roots = unique([
      headingEl?.closest(
        "[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-drawer-wrap, .semi-modal-content, .semi-modal, .semi-modal-wrap, aside, section, article, div"
      ),
      ...Array.from(document.querySelectorAll("[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-modal-content, .semi-modal, .semi-drawer-wrap, .semi-modal-wrap"))
    ])
      .filter((el) => isVisible(el))
      .map((el) => {
        const txt = normalize(el.innerText || el.textContent);
        let score = 0;
        if (/creator lead details/i.test(txt)) score += 100;
        if (/\bapplied\b/i.test(txt)) score += 20;
        if (/@[a-z0-9._]{3,}/i.test(txt)) score += 15;
        if (/\buser\d{6,}\b/i.test(txt)) score += 10;
        if (txt.length < 50) score -= 20;
        if (txt.length > 15000) score -= 20;
        return { txt, score };
      })
      .sort((a, b) => b.score - a.score);

    const best = roots[0];
    if (!best || best.score <= 0) return "";

    const lines = normalize(best.txt)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 300);

    for (const line of lines) {
      if (hasEmailLike(line)) continue;
      const m = line.match(/^@([a-z0-9._]{3,})$/i);
      if (m) return m[1].toLowerCase();
    }

    for (const line of lines) {
      if (hasEmailLike(line)) continue;
      const m = line.match(/@([a-z0-9._]{3,})\b/i);
      if (m) return m[1].toLowerCase();
    }

    for (const line of lines) {
      const m = line.match(/\b(user\d{6,})\b/i);
      if (m) return m[1].toLowerCase();
    }

    return "";
  }).catch(() => "");
}

async function getOpenedProfileSnapshot(targetPage) {
  return targetPage.evaluate(() => {
    const normalize = (v) => (v || "").toString().trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return Boolean(el.offsetParent) || style.position === "fixed";
    };
    const unique = (list) => Array.from(new Set(list.filter(Boolean)));

    const headingEl = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, div, span, p"))
      .find((el) => /creator lead details/i.test(normalize(el.textContent)));

    const roots = unique([
      headingEl?.closest(
        "[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-drawer-wrap, .semi-modal-content, .semi-modal, .semi-modal-wrap, aside, section, article, div"
      ),
      ...Array.from(document.querySelectorAll("[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-modal-content, .semi-modal, .semi-drawer-wrap, .semi-modal-wrap"))
    ])
      .filter((el) => isVisible(el))
      .map((el) => {
        const txt = normalize(el.innerText || el.textContent);
        let score = 0;
        if (/creator lead details/i.test(txt)) score += 100;
        if (/\bapplied\b/i.test(txt)) score += 20;
        return { txt, score };
      })
      .sort((a, b) => b.score - a.score);

    const best = roots[0];
    if (!best || best.score <= 0) return { openedId: "", signature: "", titleLine: "" };

    const lines = normalize(best.txt)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 80);

    let openedId = "";
    for (const line of lines) {
      const m = line.match(/^@([a-z0-9._]{3,})$/i);
      if (m) {
        openedId = m[1].toLowerCase();
        break;
      }
    }
    if (!openedId) {
      for (const line of lines) {
        const m = line.match(/@([a-z0-9._]{3,})\b/i);
        if (m) {
          openedId = m[1].toLowerCase();
          break;
        }
      }
    }
    if (!openedId) {
      for (const line of lines) {
        const m = line.match(/\b(user\d{6,})\b/i);
        if (m) {
          openedId = m[1].toLowerCase();
          break;
        }
      }
    }

    // Firma estable del panel para detectar si quedó el mismo perfil abierto.
    const sanitizedLines = lines
      .map((line) =>
        line
          .replace(/\b\d+\s*d\b/gi, "")
          .replace(/\b\d+\s*h\b/gi, "")
          .replace(/\b\d+\s*m\b/gi, "")
          .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(Boolean)
      .slice(0, 25);

    const signature = sanitizedLines.join(" | ").slice(0, 1200);
    const titleLine = lines.find((line) => !/creator lead details|applied/i.test(line)) || "";

    return { openedId, signature, titleLine };
  }).catch(() => ({ openedId: "", signature: "", titleLine: "" }));
}

async function waitForOpenedProfileId(targetPage, previousOpenedId = "") {
  const deadline = Date.now() + 5000;
  let lastId = "";
  while (Date.now() < deadline) {
    lastId = normalizeProfileId(await getOpenedProfileIdFromDetail(targetPage));
    if (lastId && (!previousOpenedId || lastId !== previousOpenedId)) {
      return lastId;
    }
    await targetPage.waitForTimeout(250).catch(() => null);
  }
  return lastId;
}

async function closeOpenedProfile(opened, page) {
  if (opened.openedNewTab) {
    await opened.targetPage.close().catch(() => null);
    await page.bringToFront().catch(() => null);
    await page.waitForTimeout(800);
    return;
  }

  const stillOnList = page.url().includes("scout-creators");
  if (!stillOnList) {
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await page.waitForTimeout(1200);
  } else {
    await clickFirstVisible(page, [
      "[aria-label*='close' i]",
      "[aria-label*='cerrar' i]",
      ".semi-modal-close",
      ".semi-drawer-close"
    ]).catch(() => null);
    await page.waitForTimeout(600);
  }
}

async function checkProfilesForPhone(page, profiles) {
  if (!profiles?.length) return [];
  console.log(`Validando teléfono en ${profiles.length} perfiles que cumplen fecha (NO-AI)...`);
  const results = [];
  const openedProfileIds = new Set();
  let previousPanelSignature = "";
  const orderedProfiles = (profiles || [])
    .filter((p) => Number.isFinite(p?.rowIndex))
    .sort((a, b) => a.rowIndex - b.rowIndex);
  const inputSeen = new Set();
  const deterministicProfiles = [];

  for (const p of orderedProfiles) {
    const key = normalizeProfileId(p.name) || `row-${p.rowIndex}`;
    if (inputSeen.has(key)) {
      console.log(`[NO-AI][cache-input] duplicado omitido: ${p.name || "(sin nombre)"} (${key})`);
      continue;
    }
    inputSeen.add(key);
    deterministicProfiles.push(p);
  }

  console.log(`[NO-AI] perfiles a inspeccionar (determinístico): ${deterministicProfiles.length}`);
  if (deterministicProfiles.length) {
    console.log("[NO-AI][PLAN] Lista final a abrir:");
    for (let i = 0; i < deterministicProfiles.length; i += 1) {
      const p = deterministicProfiles[i];
      console.log(
        `[NO-AI][PLAN][${i + 1}/${deterministicProfiles.length}] row=${p.rowIndex} | name=${p.name || "(sin nombre)"} | scouting=${p.scoutingStatus || "(sin dato)"}`
      );
    }
  }

  for (let i = 0; i < deterministicProfiles.length; i += 1) {
    const profile = deterministicProfiles[i];
    const expectedKey = normalizeProfileId(profile.name);
    console.log(
      `[NO-AI][${i + 1}/${deterministicProfiles.length}] abrir perfil: ${profile.name || "(sin nombre)"} (row=${profile.rowIndex})`
    );
    await waitForCreatorsTable(page).catch(() => null);
    const opened = await clickProfileRow(page, profile.rowIndex, profile.name);
    if (!opened?.success) {
      console.log(
        `[NO-AI][${i + 1}/${deterministicProfiles.length}] no abrió perfil: ${profile.name || "(sin nombre)"} (motivo=${opened?.clickMeta?.method || "unknown"} | matched_by=${opened?.clickMeta?.matchedBy || "unknown"})`
      );
      results.push({
        rowIndex: profile.rowIndex,
        name: profile.name,
        hasPhone: false,
        phones: [],
        phone: "",
        error: "No se pudo abrir el perfil",
        analysisCompleted: false,
        analyzedKey: expectedKey
      });
      continue;
    }

    const snapshot = await getOpenedProfileSnapshot(opened.targetPage);
    let openedId = normalizeProfileId(snapshot.openedId);
    const openedSignature = String(snapshot.signature || "").trim();
    const openedTitle = String(snapshot.titleLine || "").trim();

    const sameAsPreviousPanel =
      Boolean(previousPanelSignature) &&
      Boolean(openedSignature) &&
      openedSignature === previousPanelSignature;
    if (sameAsPreviousPanel) {
      console.log(
        `[NO-AI][${i + 1}/${deterministicProfiles.length}] no abrió perfil: ${profile.name || "(sin nombre)"} (motivo=Perfil abierto no cambió)`
      );
      await closeOpenedProfile(opened, page).catch(() => null);
      results.push({
        rowIndex: profile.rowIndex,
        name: profile.name,
        hasPhone: false,
        phones: [],
        phone: "",
        error: "Perfil abierto no cambió",
        analysisCompleted: false,
        analyzedKey: expectedKey
      });
      continue;
    }

    const matchesExpected = profileSnapshotMatchesExpected(profile.name, {
      openedId,
      signature: openedSignature,
      titleLine: openedTitle
    });
    if (!matchesExpected) {
      if (openedSignature) previousPanelSignature = openedSignature;
      console.log(
        `[NO-AI][${i + 1}/${deterministicProfiles.length}] no abrió perfil: ${profile.name || "(sin nombre)"} (motivo=Perfil abierto no coincide)`
      );
      await closeOpenedProfile(opened, page).catch(() => null);
      results.push({
        rowIndex: profile.rowIndex,
        name: profile.name,
        hasPhone: false,
        phones: [],
        phone: "",
        error: "Perfil abierto no coincide",
        analysisCompleted: false,
        analyzedKey: expectedKey
      });
      continue;
    }

    if (!openedId) {
      openedId = await waitForOpenedProfileId(opened.targetPage, "");
    }

    const finalSnapshot = await getOpenedProfileSnapshot(opened.targetPage);
    const finalMatches = profileSnapshotMatchesExpected(profile.name, finalSnapshot);
    if (!finalMatches) {
      const finalSignature = String(finalSnapshot.signature || "").trim();
      if (finalSignature) previousPanelSignature = finalSignature;
      console.log(
        `[NO-AI][${i + 1}/${deterministicProfiles.length}] omitiendo lectura: perfil final no coincide (esperado=${normalizeProfileId(profile.name)} abierto=${normalizeProfileId(finalSnapshot.openedId) || "sin-id"})`
      );
      results.push({
        rowIndex: profile.rowIndex,
        name: profile.name,
        hasPhone: false,
        phones: [],
        phone: "",
        error: "Perfil abierto no coincide con el esperado",
        analysisCompleted: false,
        analyzedKey: expectedKey
      });
      await closeOpenedProfile(opened, page);
      continue;
    }

    console.log(
      `[NO-AI][${i + 1}/${deterministicProfiles.length}] perfil abierto id=${openedId || "N/A"} titulo=${openedTitle || "N/A"} metodo_click=${opened?.clickMeta?.method || "unknown"} matched_by=${opened?.clickMeta?.matchedBy || "unknown"}`
    );
    const cacheKey = openedId || `row-${profile.rowIndex}-${normalizeProfileId(profile.name)}`;
    const isDuplicateOpen = openedProfileIds.has(cacheKey);

    if (isDuplicateOpen) {
      if (openedSignature) previousPanelSignature = openedSignature;
      const reason = openedId
        ? `Perfil abierto duplicado (${openedId})`
        : "Perfil repetido en caché";
      console.log(`[NO-AI][${i + 1}/${deterministicProfiles.length}] omitido por cache: ${reason}`);

      results.push({
        rowIndex: profile.rowIndex,
        name: profile.name,
        hasPhone: false,
        phones: [],
        phone: "",
        error: reason,
        analysisCompleted: false,
        analyzedKey: expectedKey
      });

      await closeOpenedProfile(opened, page);
      continue;
    }

    openedProfileIds.add(cacheKey);
    if (openedSignature) previousPanelSignature = openedSignature;

    const phoneInfo = await detectPhoneInProfile(opened.targetPage, profile.name).catch(() => ({
      hasPhone: false,
      phones: [],
      phone: "",
      error: "No se pudo leer el perfil"
    }));

    const phonesText = (phoneInfo?.phones || []).length ? phoneInfo.phones.join(", ") : "sin número detectado";
    console.log(
      `[NO-AI][${i + 1}/${deterministicProfiles.length}] detectado=${Boolean(phoneInfo?.hasPhone)} | ${phonesText}${phoneInfo?.error ? ` | ${phoneInfo.error}` : ""}`
    );

    results.push({
      rowIndex: profile.rowIndex,
      name: profile.name,
      hasPhone: Boolean(phoneInfo?.hasPhone),
      phones: phoneInfo?.phones || [],
      phone: phoneInfo?.phone || "",
      error: phoneInfo?.error || "",
      analysisCompleted: !phoneInfo?.error,
      analyzedKey: expectedKey || openedId
    });

    await closeOpenedProfile(opened, page);
  }

  console.log("Resultado teléfono en perfiles (NO-AI):");
  for (const r of results) {
    const phonesText = r.phones.length ? r.phones.join(", ") : "sin número detectado";
    console.log(`- ${r.name}: dejo_telefono=${r.hasPhone} | ${phonesText}${r.error ? ` | ${r.error}` : ""}`);
  }

  return results;
}

async function extractCurrentPageRows(page) {
  return page.evaluate(() => {
    const normalize = (t) => (t || "").toString().trim();
    const normalizeKey = (t) =>
      normalize(t)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const hasTimePattern = (line) =>
      /(\d+\s*d|\d+\s*h|\d+\s*m|\d{1,2}:\d{2}|left to invite|caduca|expire)/i.test(line);
    const hasScoutingStatusContext = (line) =>
      /(left to invite|to invite|invite|caduca|expira|expire|expires|vencer|vence)/i.test(line);
    const looksLikeLiveDuration = (line) =>
      /(live duration|l30d|last 30d|duration in l30)/i.test(line);

    const pickScoutingStatusWithTime = (value) => {
      const full = normalize(value);
      if (!full) return "";

      const lines = full
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const contextualTimed = lines.find(
        (line) => hasScoutingStatusContext(line) && hasTimePattern(line)
      );
      if (contextualTimed) return contextualTimed;

      const appliedTimed = lines.find(
        (line) => /\bapplied\b/i.test(full) && hasTimePattern(line)
      );
      if (appliedTimed) return appliedTimed;

      const timedLine = lines.find((line) => hasTimePattern(line) && !looksLikeLiveDuration(line));
      if (timedLine) return timedLine;

      return lines.join(" ");
    };

    const scoreScoutingCell = (value) => {
      const full = normalize(value);
      if (!full) return Number.NEGATIVE_INFINITY;
      const key = normalizeKey(full);

      let score = 0;
      if (hasScoutingStatusContext(full)) score += 100;
      if (/\bapplied\b/i.test(full)) score += 50;
      if (hasTimePattern(full)) score += 20;
      if (looksLikeLiveDuration(full)) score -= 120;
      if (key.includes("live duration")) score -= 120;
      return score;
    };

    const firstLine = (value) =>
      normalize(value)
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) || "";

    const pickLikelyName = (cellTexts, statusText) => {
      for (const text of cellTexts) {
        const line = firstLine(text);
        if (!line) continue;
        if (statusText && normalizeKey(line) === normalizeKey(statusText)) continue;
        if (hasTimePattern(line)) continue;
        if (/^(applied|invite|invitar|ver|view|detail|details)$/i.test(line)) continue;
        if (!/[a-zA-Z0-9@._-]/.test(line)) continue;
        return line;
      }
      return "";
    };

    const headerCells = Array.from(
      document.querySelectorAll("table thead tr th, [role='rowgroup'] [role='columnheader']")
    );
    const headers = headerCells.map((h) => normalize(h.innerText || h.textContent));

    let nameIndex = -1;
    let statusIndex = -1;

    headers.forEach((h, i) => {
      const text = normalizeKey(h);
      if (statusIndex === -1 && text.includes("scouting status")) statusIndex = i;
      if (nameIndex === -1 && (text.includes("creator") || text.includes("name") || text.includes("creador"))) {
        nameIndex = i;
      }
    });

    const rowCandidates = Array.from(
      document.querySelectorAll(
        "table tbody tr, [role='rowgroup'] [role='row'], .semi-table-tbody .semi-table-row, .semi-table-row"
      )
    );

    const rows = rowCandidates.filter((row) => Boolean(normalize(row?.innerText || row?.textContent)));

    const data = rows
      .map((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll("td, [role='cell'], .semi-table-row-cell"));
        if (!cells.length) return null;

        const cellTexts = cells.map((cell) => normalize(cell?.innerText || cell?.textContent)).filter(Boolean);
        if (!cellTexts.length) return null;

        const statusFromIndexed =
          statusIndex >= 0
            ? pickScoutingStatusWithTime(cells[statusIndex]?.innerText || cells[statusIndex]?.textContent)
            : "";

        let statusFromAnyCell = "";
        if (!statusFromIndexed) {
          const bestCell = cellTexts
            .map((text) => ({ text, score: scoreScoutingCell(text) }))
            .sort((a, b) => b.score - a.score)[0];
          if (bestCell && bestCell.score > 0) {
            statusFromAnyCell = pickScoutingStatusWithTime(bestCell.text);
          }
        }

        const scoutingStatus = statusFromIndexed || statusFromAnyCell;
        const nameFromIndexed =
          nameIndex >= 0 ? firstLine(cells[nameIndex]?.innerText || cells[nameIndex]?.textContent) : "";
        const name = nameFromIndexed || pickLikelyName(cellTexts, scoutingStatus);

        if (!name && !scoutingStatus) return null;
        return { rowIndex, name, scoutingStatus };
      })
      .filter(Boolean);

    return { headers, nameIndex, statusIndex, data };
  });
}

async function getTableSignature(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value || "").toString().trim();
    const activePage =
      document.querySelector("[aria-current='page']") ||
      document.querySelector(".semi-pagination-item-active");
    const activeText = normalize(activePage?.textContent);

    const rowTexts = Array.from(
      document.querySelectorAll(
        "table tbody tr, [role='rowgroup'] [role='row'], .semi-table-tbody .semi-table-row, .semi-table-row"
      )
    )
      .map((row) => normalize(row?.innerText || row?.textContent))
      .filter(Boolean)
      .slice(0, 5)
      .map((text) => text.replace(/\s+/g, " ").slice(0, 180));

    return `${activeText}||${rowTexts.join("||")}`;
  });
}

async function getPaginationState(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value || "").toString().trim();
    const toNum = (value) => {
      const n = Number(String(value || "").trim());
      return Number.isFinite(n) ? n : null;
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return Boolean(el.offsetParent) || style.position === "fixed";
    };
    const isDisabled = (el) => {
      if (!el) return true;
      if (el.hasAttribute("disabled")) return true;
      if (el.getAttribute("aria-disabled") === "true") return true;
      const className = String(el.className || "").toLowerCase();
      return className.includes("disabled");
    };

    const activeEl =
      document.querySelector("[aria-current='page']") ||
      document.querySelector(".semi-pagination-item-active");
    const activeText = normalize(activeEl?.textContent);
    const activePageNumber = toNum(activeText);

    const paginationContainers = Array.from(
      document.querySelectorAll("[class*='pagination'], [class*='Pagination'], [role='navigation']")
    );
    const scopes = paginationContainers.length ? paginationContainers : [document.body];

    const numericPages = [];
    let hasEnabledNext = false;

    for (const scope of scopes) {
      const controls = Array.from(scope.querySelectorAll("button, a, [role='button'], li, .semi-pagination-item"));
      for (const control of controls) {
        if (!isVisible(control)) continue;

        const text = normalize(control.textContent);
        const className = String(control.className || "").toLowerCase();
        const label = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""} ${text}`
          .toLowerCase()
          .trim();

        if (/^\d+$/.test(text) && !isDisabled(control)) {
          numericPages.push(Number(text));
        }

        const looksLikeNext =
          label.includes("next") ||
          label.includes("siguiente") ||
          label.includes("proxima") ||
          label.includes("próxima") ||
          className.includes("pagination-next") ||
          className.includes("pager-next");

        if (looksLikeNext && !isDisabled(control)) {
          hasEnabledNext = true;
        }
      }
    }

    return {
      activeText,
      activePageNumber,
      numericPages: Array.from(new Set(numericPages)).sort((a, b) => a - b),
      hasEnabledNext
    };
  });
}

async function goToNextPage(page, expectedNextPage = null) {
  const previousSignature = await getTableSignature(page).catch(() => "");
  const beforeState = await getPaginationState(page).catch(() => ({
    activeText: "",
    activePageNumber: null,
    numericPages: [],
    hasEnabledNext: false
  }));

  const targetPage = Number.isFinite(expectedNextPage)
    ? expectedNextPage
    : (Number.isFinite(beforeState.activePageNumber) ? beforeState.activePageNumber + 1 : null);

  console.log(
    `Paginación antes: actual=${beforeState.activeText || "?"}, target=${targetPage || "?"}, next_habilitado=${beforeState.hasEnabledNext}.`
  );

  const waitForAdvance = async (timeoutMs) => {
    const pollMs = 250;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await page.waitForTimeout(pollMs);

      const currentSignature = await getTableSignature(page).catch(() => "");
      const currentState = await getPaginationState(page).catch(() => null);

      const reachedExpectedPage =
        currentState &&
        Number.isFinite(targetPage) &&
        Number.isFinite(currentState.activePageNumber) &&
        currentState.activePageNumber === targetPage;

      const pageChanged =
        currentState &&
        Number.isFinite(beforeState.activePageNumber) &&
        Number.isFinite(currentState.activePageNumber) &&
        currentState.activePageNumber !== beforeState.activePageNumber;

      const signatureChanged = Boolean(currentSignature) && currentSignature !== previousSignature;

      if (reachedExpectedPage || pageChanged || signatureChanged) return true;
    }
    return false;
  };

  const clickPageNumber = async (pageNumber) => {
    return page.evaluate((target) => {
      const normalize = (value) => (value || "").toString().trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return Boolean(el.offsetParent) || style.position === "fixed";
      };
      const isDisabled = (el) => {
        if (!el) return true;
        if (el.hasAttribute("disabled")) return true;
        if (el.getAttribute("aria-disabled") === "true") return true;
        const className = String(el.className || "").toLowerCase();
        return className.includes("disabled");
      };

      const controls = Array.from(
        document.querySelectorAll("[class*='pagination'] button, [class*='pagination'] a, [class*='pagination'] [role='button'], [class*='pagination'] li, .semi-pagination-item")
      );

      for (const control of controls) {
        const text = normalize(control.textContent);
        if (text !== String(target)) continue;
        if (!isVisible(control) || isDisabled(control)) continue;
        const clickable = control.querySelector("button, a, [role='button']") || control;
        clickable.scrollIntoView({ block: "center", inline: "nearest" });
        clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      }
      return false;
    }, pageNumber).catch(() => false);
  };

  const clickNextControl = async () => {
    return page.evaluate(() => {
      const normalize = (value) => (value || "").toString().trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return Boolean(el.offsetParent) || style.position === "fixed";
      };
      const isDisabled = (el) => {
        if (!el) return true;
        if (el.hasAttribute("disabled")) return true;
        if (el.getAttribute("aria-disabled") === "true") return true;
        const className = String(el.className || "").toLowerCase();
        return className.includes("disabled");
      };

      const controls = Array.from(
        document.querySelectorAll("[class*='pagination'] button, [class*='pagination'] a, [class*='pagination'] [role='button'], [class*='pagination'] li, .semi-pagination-next")
      );

      for (const control of controls) {
        if (!isVisible(control) || isDisabled(control)) continue;
        const label = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""} ${normalize(control.textContent)}`
          .toLowerCase()
          .trim();
        const className = String(control.className || "").toLowerCase();
        const text = normalize(control.textContent);
        const arrowLike = [">", "›", "»", "→"].includes(text);
        const looksLikeNext =
          label.includes("next") ||
          label.includes("siguiente") ||
          label.includes("proxima") ||
          label.includes("próxima") ||
          className.includes("pagination-next") ||
          className.includes("pager-next") ||
          (arrowLike && Boolean(control.closest("[class*='pagination'], [role='navigation']")));

        if (!looksLikeNext) continue;

        const clickable = control.querySelector("button, a, [role='button']") || control;
        clickable.scrollIntoView({ block: "center", inline: "nearest" });
        clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      }
      return false;
    }).catch(() => false);
  };

  if (targetPage) {
    const clickedTarget = await clickPageNumber(targetPage);
    if (clickedTarget) {
      console.log(`Intento de avance ejecutado por: dom-target-page-${targetPage}.`);
      const changed = await waitForAdvance(16000);
      if (changed) {
        const after = await getPaginationState(page).catch(() => null);
        if (after) console.log(`Paginación después: actual=${after.activeText || "?"}.`);
        return true;
      }
    }
  }

  const clickedNext = await clickNextControl();
  if (clickedNext) {
    console.log("Intento de avance ejecutado por: dom-next-control.");
    const changed = await waitForAdvance(16000);
    if (changed) {
      const after = await getPaginationState(page).catch(() => null);
      if (after) console.log(`Paginación después: actual=${after.activeText || "?"}.`);
      return true;
    }
  }

  if (targetPage) {
    const retryTarget = await clickPageNumber(targetPage);
    if (retryTarget) {
      console.log(`Intento de avance ejecutado por: dom-target-page-${targetPage}-retry.`);
      const changed = await waitForAdvance(12000);
      if (changed) {
        const after = await getPaginationState(page).catch(() => null);
        if (after) console.log(`Paginación después: actual=${after.activeText || "?"}.`);
        return true;
      }
    }
  }

  const after = await getPaginationState(page).catch(() => null);
  if (after) console.log(`Paginación después: actual=${after.activeText || "?"}.`);
  console.log("No se detectó cambio de página tras todos los intentos (NO-AI).");
  return false;
}

async function main() {
  console.log(`[NO-AI] Ejecutando ${NO_AI_BUILD_TAG}`);
  const dateInput = getDateInputFromArgs();
  const cutoffDate = parseInputDate(dateInput);

  if (!cutoffDate) {
    console.error("Fecha inválida o faltante.");
    console.error("Usa: --fecha \"2026-04-16\", --fecha \"16/04/2026\" o --fecha \"16 de abril\".");
    process.exit(1);
  }

  const now = new Date();
  if (cutoffDate.getTime() > now.getTime()) {
    console.error(`La fecha ingresada (${cutoffDate.toLocaleDateString("es-CO")}) está en el futuro.`);
    process.exit(1);
  }

  const referenceNow = new Date();
  const referenceNowText = formatLocalDateTime(referenceNow);
  const cutoffDateText = cutoffDate.toLocaleDateString("es-CO");
  console.log(`Hora local de referencia: ${referenceNowText}.`);
  console.log(`Fecha de corte: ${cutoffDateText}.`);
  console.log("Regla: cumple si (ahora_local - (7d - scouting_status)) > fecha_de_corte.");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  if (fs.existsSync(AUTH_FILE)) {
    console.log("Restaurando sesión guardada...");
    try {
      const { cookies, origins } = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
      if (cookies?.length) await context.addCookies(cookies);
      if (origins?.length) {
        const tmpPage = await context.newPage();
        for (const { origin, localStorage: items } of origins) {
          await tmpPage.goto(origin, { waitUntil: "domcontentloaded" });
          await tmpPage.evaluate((entries) => {
            for (const { name, value } of entries) window.localStorage.setItem(name, value);
          }, items);
        }
        await tmpPage.close();
      }
      console.log("Sesión restaurada.");
    } catch (e) {
      console.warn("Error al leer auth.json, iniciando desde cero:", e.message);
      fs.unlinkSync(AUTH_FILE);
    }
  }

  const page = await context.newPage();
  await page.goto(LOGIN_CHECK_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const isLoggedIn = page.url().includes("live-backstage.tiktok.com/portal");

  if (!isLoggedIn) {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
      console.log("Sesión inválida detectada, auth.json eliminado.");
    }

    console.log("No hay sesión activa, haciendo login...");
    const loginClicked = await clickFirstVisible(page, [
      "text=/Log in/i",
      "text=/Login/i",
      "button:has-text('Log in')",
      "button:has-text('Login')"
    ]);

    if (!loginClicked) {
      console.warn("No encontré el botón de login automáticamente.");
    }

    console.log("Completá el login manualmente en el navegador (incluyendo verificación humana)...");
    const loginTimeout = 5 * 60 * 1000;
    const loginStart = Date.now();

    while (!page.url().includes("live-backstage.tiktok.com/portal")) {
      if (Date.now() - loginStart > loginTimeout) {
        console.warn("Timeout esperando login. Guardando estado actual de todas formas...");
        break;
      }
      await page.waitForTimeout(2000);
    }

    const cookies = await context.cookies();
    const currentUrl = page.url();
    const localStorageItems = await page.evaluate(() =>
      Object.entries(window.localStorage).map(([name, value]) => ({ name, value }))
    );

    const sessionState = {
      cookies,
      origins: localStorageItems.length ? [{ origin: currentUrl, localStorage: localStorageItems }] : [],
    };

    fs.writeFileSync(AUTH_FILE, JSON.stringify(sessionState, null, 2));
    console.log(`Sesión guardada en ${AUTH_FILE}`);
  } else {
    console.log("Sesión válida detectada, ya estás logueado.");
  }

  console.log("Navegando a Scout Creators > Application...");
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  await waitForCreatorsTable(page);
  await setItemsPerPageTo100(page);
  await waitForCreatorsTable(page);

  const collected = [];
  const seen = new Set();
  const phoneByProfileKey = new Map();
  const analyzedProfilesCache = loadAnalyzedProfilesCache();
  console.log(
    `[NO-AI] Cache de perfiles analizados: ${analyzedProfilesCache.size} (${ANALYZED_PROFILES_FILE})`
  );
  const maxPages = 50;
  let pageIndex = 1;
  let printedHeaders = false;
  let warnedMissingHeader = false;

  while (pageIndex <= maxPages) {
    const extractedRows = await extractCurrentPageRows(page);

    if (!printedHeaders) {
      console.log("Headers de la tabla:", extractedRows.headers);
      printedHeaders = true;
    }

    if (extractedRows.statusIndex === -1 && !warnedMissingHeader) {
      console.warn("No encontré header 'Scouting status'; uso detección por contenido de filas.");
      warnedMissingHeader = true;
    }

    const normalizedRows = (extractedRows.data || [])
      .map((p) => ({
        rowIndex: p.rowIndex,
        name: p.name || p.creator || p.creatorName || "",
        scoutingStatus:
          p.scoutingStatus ||
          p.scouting ||
          p.incorporationStatus ||
          p.status ||
          p.incorporacion ||
          p.incorporation ||
          p.estadoIncorporacion ||
          "",
      }))
      .filter((p) => p.name || p.scoutingStatus)
      .map((p) => {
        const remainingMinutes = parseIncorporationToMinutes(p.scoutingStatus);
        const appliedAt = getApplicationDateFromRemaining(referenceNow, remainingMinutes);
        const qualifies = Boolean(appliedAt) && appliedAt.getTime() > cutoffDate.getTime();
        return {
          ...p,
          remainingMinutes,
          appliedAtMs: appliedAt ? appliedAt.getTime() : NaN,
          appliedAtText: appliedAt ? formatLocalDateTime(appliedAt) : "",
          qualifies,
        };
      });

    if (!normalizedRows.length) {
      console.log(`Página ${pageIndex}: no se encontraron filas. Fin del recorrido.`);
      break;
    }

    console.log(`Detalle por item en página ${pageIndex}:`);
    for (const p of normalizedRows) {
      const inferredText = p.appliedAtText || "N/A";
      const compareText = p.appliedAtText
        ? `${inferredText} > ${cutoffDateText} = ${p.qualifies}`
        : `N/A > ${cutoffDateText} = false`;
      console.log(
        `- ${p.name || "(sin nombre)"} | scouting status: ${p.scoutingStatus || "(sin dato)"} | hoy: ${referenceNowText} | fecha_aplicación_inferida: ${inferredText} | comparación: ${compareText}`
      );
    }

    const pageMatches = normalizedRows.filter((p) => p.qualifies);

    const profileKey = (p) => normalizeProfileId(p?.name || "");
    const toInspect = pageMatches.filter(
      (p) =>
        Number.isFinite(p.rowIndex) &&
        !phoneByProfileKey.has(profileKey(p)) &&
        !analyzedProfilesCache.has(profileKey(p))
    );
    console.log(
      `[NO-AI][PLAN][page=${pageIndex}] qualifies=${pageMatches.length} | pending_open=${toInspect.length} | cached=${pageMatches.length - toInspect.length}`
    );
    if (toInspect.length) {
      console.log(`[NO-AI][PLAN][page=${pageIndex}] Lista antes de abrir:`);
      for (let i = 0; i < toInspect.length; i += 1) {
        const p = toInspect[i];
        console.log(
          `[NO-AI][PLAN][page=${pageIndex}][${i + 1}/${toInspect.length}] row=${p.rowIndex} | name=${p.name || "(sin nombre)"} | scouting=${p.scoutingStatus || "(sin dato)"} | aplicada=${p.appliedAtText || "N/A"}`
        );
      }
    }

    if (toInspect.length) {
      const phoneResults = await checkProfilesForPhone(page, toInspect);
      let cacheUpdated = false;
      for (const result of phoneResults) {
        const key = normalizeProfileId(result?.name || "");
        if (!key) continue;
        phoneByProfileKey.set(key, {
          hasPhone: Boolean(result.hasPhone),
          phone: result.phone || "",
          phones: result.phones || []
        });

        const analyzedKey = normalizeProfileId(result?.analyzedKey || key);
        if (result?.analysisCompleted && analyzedKey && !analyzedProfilesCache.has(analyzedKey)) {
          analyzedProfilesCache.add(analyzedKey);
          cacheUpdated = true;
        }
      }
      if (cacheUpdated) {
        saveAnalyzedProfilesCache(analyzedProfilesCache);
        console.log(
          `[NO-AI] Cache actualizada: ${analyzedProfilesCache.size} perfiles analizados.`
        );
      }
      await waitForCreatorsTable(page).catch(() => null);
    }

    for (const p of pageMatches) {
      const key = `${p.name}||${p.scoutingStatus}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pKey = profileKey(p);
      if (analyzedProfilesCache.has(pKey) && !phoneByProfileKey.has(pKey)) {
        continue;
      }
      const phoneInfo = phoneByProfileKey.get(pKey) || {
        hasPhone: false,
        phone: "",
        phones: []
      };
      collected.push({
        ...p,
        hasPhone: phoneInfo.hasPhone,
        phone: phoneInfo.phone,
        phones: phoneInfo.phones
      });
    }

    const comparableRows = normalizedRows.filter((p) => Number.isFinite(p.remainingMinutes));
    const lastRow = comparableRows[comparableRows.length - 1] || normalizedRows[normalizedRows.length - 1];
    const lastMinutes = lastRow?.remainingMinutes;
    const lastQualifies = Boolean(lastRow?.qualifies);

    const minutesLabel = Number.isFinite(lastMinutes) ? ` (${formatMinutesAsDhM(lastMinutes)})` : "";
    const appliedAtLabel = lastRow?.appliedAtText ? ` -> aplicada: ${lastRow.appliedAtText}` : "";
    console.log(
      `Página ${pageIndex}: ${normalizedRows.length} filas, ${pageMatches.length} cumplen. Último: ${lastRow.scoutingStatus}${minutesLabel}${appliedAtLabel}.`
    );

    if (!lastQualifies) {
      console.log("El último item ya no cumple la fecha de corte. Se detiene la paginación.");
      break;
    }

    const moved = await goToNextPage(page, pageIndex + 1);
    if (!moved) {
      console.log("No hay siguiente página disponible o no se pudo avanzar.");
      break;
    }

    pageIndex += 1;
    await waitForCreatorsTable(page);
  }

  if (pageIndex > maxPages) {
    console.warn(`Se alcanzó el límite de seguridad de ${maxPages} páginas.`);
  }

  const filtered = collected.sort((a, b) => b.appliedAtMs - a.appliedAtMs);

  console.log(`Creadores (Scouting status) con fecha de aplicación inferida mayor a ${cutoffDateText}:`);
  if (!filtered.length) {
    console.log("No se encontraron resultados.");
  } else {
    for (const p of filtered) {
      const phoneText = p.hasPhone ? (p.phone || (p.phones || []).join(", ")) : "sin teléfono";
      console.log(
        `- ${p.name} | scouting status: ${p.scoutingStatus} | hoy: ${referenceNowText} | fecha_aplicación_inferida: ${p.appliedAtText} | comparación: ${p.appliedAtText} > ${cutoffDateText} = ${p.qualifies} | dejó_tel=${p.hasPhone} | teléfono=${phoneText}`
      );
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
