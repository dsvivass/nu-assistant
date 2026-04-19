import "dotenv/config";
import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";

const AUTH_FILE = "./auth.json";
const TARGET_URL = "https://live-backstage.tiktok.com/portal/anchor/scout-creators?tab=2&type=2";

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
const INCORPORATION_WINDOW_MINUTES = 7 * 24 * 60;

function normalizeText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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
    if (arg.startsWith("--fecha=")) {
      return arg.slice("--fecha=".length).trim();
    }
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
  return date.toLocaleString("es-CO", {
    hour12: false
  });
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

async function waitForCreatorsTable(page) {
  await page.waitForSelector("table, [role='grid'], [role='table']", { timeout: 45000 });
  await page.waitForTimeout(1200);
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
        // Intentar siguiente candidato.
      }
    }
  }
  return false;
}

async function setItemsPerPageTo100(stagehand, page) {
  console.log("Configurando Elementos por página en 100...");
  try {
    await stagehand.act("In the table pagination controls, set 'Elementos por página' to 100.");
    await page.waitForTimeout(2000);
  } catch (e) {
    console.warn("No se pudo configurar con Stagehand.act, intentando con selectores:", e.message);
  }

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
    await page.waitForTimeout(1800);
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

async function getFirstProfileRows(page, limit = 3) {
  return page.evaluate((maxRows) => {
    const normalize = (v) => (v || "").toString().trim();
    const rows = Array.from(
      document.querySelectorAll(
        "table tbody tr, [role='rowgroup'] [role='row'], .semi-table-tbody .semi-table-row, .semi-table-row"
      )
    );

    const data = [];
    for (let i = 0; i < rows.length && data.length < maxRows; i += 1) {
      const row = rows[i];
      const cells = Array.from(row.querySelectorAll("td, [role='cell'], .semi-table-row-cell"));
      if (!cells.length) continue;

      let name = "";
      for (const cell of cells) {
        const line = normalize(cell.innerText || cell.textContent)
          .split("\n")
          .map((s) => s.trim())
          .find(Boolean);
        if (!line) continue;
        if (/(left to invite|live duration|applied|invite)/i.test(line)) continue;
        if (!/[a-zA-Z0-9@._-]/.test(line)) continue;
        name = line;
        break;
      }

      if (!name) name = `(fila ${i + 1})`;
      data.push({ rowIndex: i, name });
    }
    return data;
  }, limit);
}

async function clickProfileRow(stagehand, page, rowIndex, nameHint) {
  const beforeCount = stagehand.context.pages().length;

  const domClicked = await page.evaluate((idx) => {
    const rows = Array.from(
      document.querySelectorAll(
        "table tbody tr, [role='rowgroup'] [role='row'], .semi-table-tbody .semi-table-row, .semi-table-row"
      )
    );
    const row = rows[idx];
    if (!row) return false;

    const avatar = row.querySelector("img, [class*='avatar'], [class*='Avatar']");
    if (avatar) {
      const avatarClickable =
        avatar.closest("a, button, [role='button'], td, [role='cell'], .semi-table-row-cell, div");
      if (avatarClickable) {
        try {
          avatarClickable.scrollIntoView({ block: "center", inline: "nearest" });
          avatarClickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          return true;
        } catch (_) {
          // continuar con fallback
        }
      }
    }

    const candidates = Array.from(row.querySelectorAll("a, button, [role='button'], td, [role='cell'], .semi-table-row-cell"));
    for (const el of candidates) {
      const txt = (el.textContent || "").trim();
      const className = String(el.className || "").toLowerCase();
      const looksClickable =
        el.tagName === "A" ||
        el.tagName === "BUTTON" ||
        el.getAttribute("role") === "button" ||
        className.includes("link") ||
        className.includes("click");
      if (!looksClickable && !txt) continue;
      if (/left to invite|live duration|invite|assign|chat/i.test(txt)) continue;

      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (_) {
        // continue
      }
    }
    return false;
  }, rowIndex).catch(() => false);

  if (!domClicked) {
    return { success: false, targetPage: page, openedNewTab: false };
  }

  await page.waitForTimeout(1800);
  const pagesAfter = stagehand.context.pages();
  if (pagesAfter.length > beforeCount) {
    const targetPage = pagesAfter[pagesAfter.length - 1];
    await targetPage.bringToFront().catch(() => null);
    await targetPage.waitForTimeout(1200).catch(() => null);
    return { success: true, targetPage, openedNewTab: true };
  }

  return { success: true, targetPage: page, openedNewTab: false };
}

async function detectPhoneInProfile(targetPage, profileName = "") {
  await targetPage.waitForTimeout(400).catch(() => null);

  await targetPage.evaluate(() => {
    const normalize = (v) => (v || "").toString().trim();
    const hasPhoneLike = (t) => /(\+?\d[\d\s().*\-]{6,})/.test(t);
    const hasEmailLike = (t) => /@/.test(t);

    const containers = Array.from(document.querySelectorAll("div, section, article, li"))
      .map((el) => ({ el, txt: normalize(el.innerText || el.textContent) }))
      .filter(({ txt }) => txt && txt.length <= 400)
      .filter(({ txt }) => hasPhoneLike(txt) || hasEmailLike(txt))
      .sort((a, b) => a.txt.length - b.txt.length)
      .map(({ el }) => el);

    const preferredContainer = containers.find((el) => {
      const txt = normalize(el.innerText || el.textContent);
      return hasPhoneLike(txt) && hasEmailLike(txt);
    }) || containers[0] || document.body;

    const candidates = [];
    const pushAll = (root, selector) => {
      if (!root) return;
      root.querySelectorAll(selector).forEach((el) => candidates.push(el));
    };

    const roots = [
      preferredContainer,
      preferredContainer?.parentElement,
      preferredContainer?.parentElement?.parentElement,
      document
    ];

    for (const root of roots) {
      pushAll(root, "[aria-label*='eye' i]");
      pushAll(root, "[title*='eye' i]");
      pushAll(root, "[aria-label*='show' i]");
      pushAll(root, "[title*='show' i]");
      pushAll(root, "[class*='eye' i]");
      pushAll(root, "svg[class*='eye' i], i[class*='eye' i]");
    }

    const seen = new Set();
    for (const raw of candidates.slice(0, 12)) {
      const el = raw.closest("button, [role='button'], a, span, div") || raw;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } catch (_) {
        // continue
      }
    }
  }).catch(() => null);

  await targetPage.waitForTimeout(1200).catch(() => null);

  return targetPage.evaluate((nameHint) => {
    const normalize = (v) => (v || "").toString().trim();
    const hasPhoneLike = (t) => /(\+?\d[\d\s().*\-]{6,})/.test(t);
    const hasEmailLike = (t) => /@/.test(t);
    const lineHasUserHandle = (line) => /(^|\s)@?user\d{6,}/i.test(line);
    const lineHasPhoneContext = (line) =>
      /(phone|telefono|teléfono|celular|whatsapp|contact|call|llamar)/i.test(line);
    const normalizedNameHint = normalize(nameHint).toLowerCase();
    const hintedNumbers = new Set(
      (normalizedNameHint.match(/\d{6,}/g) || []).map((d) => d.trim())
    );

    const containers = Array.from(document.querySelectorAll("div, section, article, li"))
      .map((el) => ({ el, txt: normalize(el.innerText || el.textContent) }))
      .filter(({ txt }) => txt && txt.length <= 500)
      .filter(({ txt }) => hasPhoneLike(txt) || hasEmailLike(txt))
      .sort((a, b) => a.txt.length - b.txt.length)
      .map(({ el }) => el);

    const preferredContainer = containers.find((el) => {
      const txt = normalize(el.innerText || el.textContent);
      return hasPhoneLike(txt) && hasEmailLike(txt);
    }) || containers[0] || null;

    const scopeText = preferredContainer
      ? normalize(preferredContainer.innerText || preferredContainer.textContent)
      : "";

    const lines = scopeText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 30);

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
            const compact = raw.replace(/[^\d+*]/g, "");
            if (!compact || compact.includes("*")) return "";

            const digits = compact.replace(/\D/g, "");
            if (digits.length < 8 || digits.length > 13) return "";

            // Evitar confundir IDs de username/handle con teléfono.
            if (lineHasUserHandle(line)) return "";
            if (hintedNumbers.has(digits)) return "";
            if (normalizedNameHint && normalize(line).toLowerCase().includes(normalizedNameHint)) return "";

            const hasPlusOrSeparators = raw.includes("+") || /[().\s-]/.test(raw);
            if (!hasPlusOrSeparators) {
              // Números planos sin contexto suelen ser IDs; aceptar solo longitudes típicas cortas.
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

async function detectInviteAvailabilityInProfile(stagehand, targetPage) {
  const fallbackUnknown = {
    inviteStatus: "unknown",
    inviteAvailable: null,
    inviteClicked: false,
    inviteDetail: "invite-check-failed"
  };

  try {
    await targetPage.waitForTimeout(300).catch(() => null);

    let clicked = false;
    let clickSource = "";
    let inviteSelector = "";
    let inviteLabel = "";
    let isDisabledBefore = null;
    let inviteLocator = null;

    const domAttempt = await targetPage.evaluate(() => {
      const normalize = (v) => (v || "").toString().trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return Boolean(el.offsetParent) || style.position === "fixed";
      };
      const isDisabled = (el) => {
        if (!el) return true;
        if (el.hasAttribute("disabled")) return true;
        if ((el.getAttribute("aria-disabled") || "").toLowerCase() === "true") return true;
        return String(el.className || "").toLowerCase().includes("disabled");
      };
      const unique = (list) => Array.from(new Set(list.filter(Boolean)));

      const headingEl = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, div, span, p"))
        .find((el) => /creator lead details/i.test(normalize(el.textContent)));

      const rootCandidates = unique([
        headingEl?.closest(
          "[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-drawer-wrap, .semi-modal-content, .semi-modal, .semi-modal-wrap, aside, section, article, div"
        ),
        ...Array.from(document.querySelectorAll("[role='dialog'], .semi-drawer-content, .semi-drawer, .semi-modal-content, .semi-modal, .semi-drawer-wrap, .semi-modal-wrap")),
        document.body
      ]);
      const scopes = rootCandidates.filter((el) => isVisible(el));

      let best = null;
      for (const scope of scopes) {
        const controls = Array.from(scope.querySelectorAll("button, [role='button'], a"));
        for (const control of controls) {
          if (!isVisible(control)) continue;

          const text = normalize(control.innerText || control.textContent);
          const aria = normalize(control.getAttribute("aria-label"));
          const title = normalize(control.getAttribute("title"));
          const merged = normalize(`${text} ${aria} ${title}`).toLowerCase();
          if (!merged) continue;
          if (!/\b(invite|invitar)\b/i.test(merged)) continue;
          if (/left to invite/i.test(merged)) continue;

          let score = 0;
          if (/^\s*(invite|invitar)\s*$/i.test(text)) score += 100;
          if (/^\s*(invite|invitar)\s*$/i.test(aria)) score += 70;
          if (/^\s*(invite|invitar)\s*$/i.test(title)) score += 60;
          if (/\b(invite|invitar)\b/i.test(text)) score += 30;
          if (/\b(invite|invitar)\b/i.test(aria) || /\b(invite|invitar)\b/i.test(title)) score += 20;
          if (isDisabled(control)) score -= 120;

          const candidate = {
            el: control,
            score,
            label: `${text} ${aria} ${title}`.trim(),
            disabled: isDisabled(control)
          };
          if (!best || candidate.score > best.score) best = candidate;
        }
      }

      if (!best) {
        return {
          found: false,
          clicked: false,
          disabled: false,
          label: "",
          detail: "invite-control-not-found-in-profile-panel"
        };
      }

      if (best.disabled) {
        return {
          found: true,
          clicked: false,
          disabled: true,
          label: best.label,
          detail: "invite-disabled-in-profile-panel"
        };
      }

      try {
        best.el.scrollIntoView({ block: "center", inline: "nearest" });
        best.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return {
          found: true,
          clicked: true,
          disabled: false,
          label: best.label,
          detail: "invite-clicked-dom-profile-panel"
        };
      } catch (_) {
        return {
          found: true,
          clicked: false,
          disabled: false,
          label: best.label,
          detail: "invite-dom-click-failed"
        };
      }
    }).catch(() => ({
      found: false,
      clicked: false,
      disabled: false,
      label: "",
      detail: "invite-dom-check-failed"
    }));

    if (domAttempt.found) {
      inviteSelector = "dom-profile-panel";
      inviteLabel = domAttempt.label || "";
      if (domAttempt.disabled) {
        return {
          inviteStatus: "not-available",
          inviteAvailable: false,
          inviteClicked: false,
          inviteDetail: `invite-disabled:${inviteSelector}:${inviteLabel || domAttempt.detail || "no-label"}`
        };
      }
      if (domAttempt.clicked) {
        clicked = true;
        clickSource = "dom";
        isDisabledBefore = false;
      }
    }

    if (!clicked) {
      const candidateLocators = [
        { name: "role-button-exact", locator: targetPage.getByRole("button", { name: /^\s*(invite|invitar)\s*$/i }) },
        { name: "role-link-exact", locator: targetPage.getByRole("link", { name: /^\s*(invite|invitar)\s*$/i }) },
        { name: "clickable-exact-text", locator: targetPage.locator("button, [role='button'], a").filter({ hasText: /^\s*(invite|invitar)\s*$/i }) },
        { name: "clickable-contains-text", locator: targetPage.locator("button, [role='button'], a").filter({ hasText: /\b(invite|invitar)\b/i }) }
      ];

      for (const group of candidateLocators) {
        const count = await group.locator.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 10); i += 1) {
          const candidate = group.locator.nth(i);
          const visible = await candidate.isVisible().catch(() => false);
          if (!visible) continue;

          const text = (await candidate.innerText().catch(() => "")).trim();
          const aria = ((await candidate.getAttribute("aria-label").catch(() => "")) || "").trim();
          const title = ((await candidate.getAttribute("title").catch(() => "")) || "").trim();
          const merged = `${text} ${aria} ${title}`.trim();
          if (!/(invite|invitar)/i.test(merged)) continue;
          if (/left to invite/i.test(merged)) continue;

          inviteLocator = candidate;
          inviteSelector = group.name;
          inviteLabel = merged;
          break;
        }
        if (inviteLocator) break;
      }
    }

    if (!clicked && !inviteLocator && stagehand) {
      try {
        await targetPage.bringToFront().catch(() => null);
        await stagehand.act(
          "Inside the opened creator profile details drawer/modal, click exactly the Invite button once. Do not click 'left to invite'."
        );
        clicked = true;
        clickSource = "stagehand-direct";
        inviteSelector = inviteSelector || "stagehand-direct";
      } catch (_) {
        // Ignorar fallback fallido.
      }
    }

    if (!clicked && inviteLocator) {
      const disabledBefore = await inviteLocator.isDisabled().catch(() => false);
      const ariaDisabledBefore = ((await inviteLocator.getAttribute("aria-disabled").catch(() => "")) || "").toLowerCase();
      const classBefore = ((await inviteLocator.getAttribute("class").catch(() => "")) || "").toLowerCase();
      isDisabledBefore = disabledBefore || ariaDisabledBefore === "true" || classBefore.includes("disabled");

      if (isDisabledBefore) {
        return {
          inviteStatus: "not-available",
          inviteAvailable: false,
          inviteClicked: false,
          inviteDetail: `invite-disabled:${inviteSelector}:${inviteLabel || "no-label"}`
        };
      }

      const clickedWithPlaywright = await inviteLocator
        .scrollIntoViewIfNeeded()
        .then(async () => {
          await inviteLocator.click({ timeout: 2500 });
          return true;
        })
        .catch(async () => {
          return inviteLocator
            .click({ timeout: 2500, force: true })
            .then(() => true)
            .catch(() => false);
        });

      if (clickedWithPlaywright) {
        clicked = true;
        clickSource = "playwright";
      }
    }

    if (!clicked && stagehand) {
      try {
        await targetPage.bringToFront().catch(() => null);
        await stagehand.act(
          "Inside the opened creator profile details drawer/modal, click exactly the Invite button once. Do not click 'left to invite'."
        );
        clicked = true;
        clickSource = "stagehand-fallback";
      } catch (_) {
        // Ignorar fallback fallido.
      }
    }

    await targetPage.waitForTimeout(1000).catch(() => null);

    const postState = await targetPage.evaluate(() => {
      const normalize = (v) => (v || "").toString().trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return Boolean(el.offsetParent) || style.position === "fixed";
      };

      const roots = [
        ...Array.from(document.querySelectorAll("[role='alert'], [class*='toast'], [class*='Toast'], .semi-notification, .semi-modal, .semi-drawer")),
        document.body
      ];

      const snippets = roots
        .filter((el) => isVisible(el))
        .map((el) => normalize(el.innerText || el.textContent))
        .filter(Boolean)
        .slice(0, 6);

      const merged = snippets.join("\n").slice(0, 4000);
      const lower = merged.toLowerCase();

      if (/(not available|unavailable|no disponible|not eligible|cannot invite|can't invite|already invited|invitation limit|l[ií]mite de invitaci[oó]n)/i.test(lower)) {
        return { inviteStatus: "not-available", inviteAvailable: false, snippet: merged.slice(0, 240) };
      }

      if (/(available|disponible|send invite|invitation sent|invite success|invited successfully)/i.test(lower)) {
        return { inviteStatus: "available", inviteAvailable: true, snippet: merged.slice(0, 240) };
      }

      return { inviteStatus: "unknown", inviteAvailable: null, snippet: merged.slice(0, 240) };
    }).catch(() => ({ inviteStatus: "unknown", inviteAvailable: null, snippet: "" }));

    let isDisabledAfter = false;
    if (inviteLocator) {
      const disabledAfter = await inviteLocator.isDisabled().catch(() => false);
      const ariaDisabledAfter = ((await inviteLocator.getAttribute("aria-disabled").catch(() => "")) || "").toLowerCase();
      const classAfter = ((await inviteLocator.getAttribute("class").catch(() => "")) || "").toLowerCase();
      isDisabledAfter = disabledAfter || ariaDisabledAfter === "true" || classAfter.includes("disabled");
    }

    if (postState.inviteStatus === "unknown" && clicked && isDisabledBefore === false && isDisabledAfter) {
      return {
        inviteStatus: "available",
        inviteAvailable: true,
        inviteClicked: true,
        inviteDetail: `invite-state-changed:${clickSource || "unknown"}:${inviteSelector}:${inviteLabel || "no-label"}`
      };
    }

    return {
      inviteStatus: postState.inviteStatus,
      inviteAvailable: postState.inviteAvailable,
      inviteClicked: clicked,
      inviteDetail:
        postState.snippet ||
        `${clicked ? "invite-clicked" : "invite-not-clicked"}:${clickSource || "none"}:${inviteSelector || "no-selector"}:${inviteLabel || "no-label"}`
    };
  } catch (_) {
    return fallbackUnknown;
  }
}

function normalizeProfileId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\s+/g, "");
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
        return { el, txt, score };
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

async function checkProfilesForPhone(stagehand, page, profiles) {
  if (!profiles?.length) return [];
  console.log(`Validando teléfono e invite en ${profiles.length} perfiles que cumplen fecha...`);
  const results = [];
  const openedProfileIds = new Set();

  for (const profile of profiles) {
    await waitForCreatorsTable(page).catch(() => null);
    const opened = await clickProfileRow(stagehand, page, profile.rowIndex, profile.name);
    if (!opened.success) {
      results.push({
        rowIndex: profile.rowIndex,
        name: profile.name,
        hasPhone: false,
        phones: [],
        phone: "",
        inviteStatus: "unknown",
        inviteAvailable: null,
        inviteClicked: false,
        inviteDetail: "profile-not-opened",
        error: "No se pudo abrir el perfil"
      });
      continue;
    }

    const openedId = normalizeProfileId(await getOpenedProfileIdFromDetail(opened.targetPage));
    const cacheKey = openedId || `row-${profile.rowIndex}-${normalizeProfileId(profile.name)}`;
    const isDuplicateOpen = openedProfileIds.has(cacheKey);

    if (isDuplicateOpen) {
      const reason = openedId
        ? `Perfil abierto duplicado (${openedId})`
        : "Perfil repetido en caché";

      results.push({
        rowIndex: profile.rowIndex,
        name: profile.name,
        hasPhone: false,
        phones: [],
        phone: "",
        inviteStatus: "unknown",
        inviteAvailable: null,
        inviteClicked: false,
        inviteDetail: "duplicate-profile-skipped",
        error: reason
      });

      await closeOpenedProfile(opened, page);
      continue;
    }

    openedProfileIds.add(cacheKey);

    const phoneInfo = await detectPhoneInProfile(opened.targetPage, profile.name).catch(() => ({
      hasPhone: false,
      phones: [],
      phone: "",
      error: "No se pudo leer el perfil"
    }));

    const inviteInfo = await detectInviteAvailabilityInProfile(stagehand, opened.targetPage).catch(() => ({
      inviteStatus: "unknown",
      inviteAvailable: null,
      inviteClicked: false,
      inviteDetail: "invite-check-failed"
    }));

    results.push({
      rowIndex: profile.rowIndex,
      name: profile.name,
      hasPhone: Boolean(phoneInfo?.hasPhone),
      phones: phoneInfo?.phones || [],
      phone: phoneInfo?.phone || "",
      inviteStatus: inviteInfo?.inviteStatus || "unknown",
      inviteAvailable: inviteInfo?.inviteAvailable ?? null,
      inviteClicked: Boolean(inviteInfo?.inviteClicked),
      inviteDetail: inviteInfo?.inviteDetail || "",
      error: phoneInfo?.error || ""
    });

    await closeOpenedProfile(opened, page);
  }

  console.log("Resultado teléfono + invite en perfiles:");
  for (const r of results) {
    const phonesText = r.phones.length ? r.phones.join(", ") : "sin número detectado";
    const inviteDetail = r.inviteDetail ? ` (${String(r.inviteDetail).slice(0, 120)})` : "";
    console.log(
      `- ${r.name}: dejo_telefono=${r.hasPhone} | ${phonesText} | invite=${r.inviteStatus}${inviteDetail}${r.error ? ` | ${r.error}` : ""}`
    );
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

      const contextualLine = lines.find((line) => hasScoutingStatusContext(line));
      if (contextualLine) return contextualLine;

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
    let incorporationIndex = -1;

    headers.forEach((h, i) => {
      const text = normalizeKey(h);
      if (incorporationIndex === -1 && text.includes("scouting status")) {
        incorporationIndex = i;
      } else if (
        incorporationIndex === -1 &&
        (text.includes("estado de incorporacion") ||
          text.includes("incorporacion") ||
          text.includes("incorporation"))
      ) {
        incorporationIndex = i;
      }
      if (nameIndex === -1 && (text.includes("creator") || text.includes("name") || text.includes("creador"))) {
        nameIndex = i;
      }
    });

    const rowCandidates = Array.from(
      document.querySelectorAll(
        "table tbody tr, [role='rowgroup'] [role='row'], .semi-table-tbody .semi-table-row, .semi-table-row"
      )
    );
    const rows = rowCandidates.filter((row) => {
      const text = normalize(row?.innerText || row?.textContent);
      return Boolean(text);
    });

    const data = rows
      .map((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll("td, [role='cell'], .semi-table-row-cell"));
        if (!cells.length) return null;

        const cellTexts = cells
          .map((cell) => normalize(cell?.innerText || cell?.textContent))
          .filter(Boolean);
        if (!cellTexts.length) return null;

        const statusFromIndexedCell =
          incorporationIndex >= 0
            ? pickScoutingStatusWithTime(cells[incorporationIndex]?.innerText || cells[incorporationIndex]?.textContent)
            : "";
        let statusFromAnyCell = "";
        if (!statusFromIndexedCell) {
          const bestCell = cellTexts
            .map((text) => ({ text, score: scoreScoutingCell(text) }))
            .sort((a, b) => b.score - a.score)[0];
          if (bestCell && bestCell.score > 0) {
            statusFromAnyCell = pickScoutingStatusWithTime(bestCell.text);
          }
        }
        const incorporationStatus = statusFromIndexedCell || statusFromAnyCell;

        const nameFromIndexedCell =
          nameIndex >= 0 ? firstLine(cells[nameIndex]?.innerText || cells[nameIndex]?.textContent) : "";
        const name = nameFromIndexedCell || pickLikelyName(cellTexts, incorporationStatus);

        if (!name && !incorporationStatus) return null;
        return { rowIndex, name, incorporationStatus };
      })
      .filter(Boolean);

    return { headers, nameIndex, incorporationIndex, data };
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

async function goToNextPage(stagehand, page, expectedNextPage = null) {
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

      const signatureChanged =
        Boolean(currentSignature) &&
        currentSignature !== previousSignature;

      if (reachedExpectedPage || pageChanged || signatureChanged) {
        return true;
      }
    }

    return false;
  };

  const attemptActions = [];
  if (targetPage) {
    attemptActions.push({
      name: `stagehand-target-page-${targetPage}`,
      prompt: `Scroll to the table pagination and click page ${targetPage}. If not visible, use the pagination next control until page ${targetPage} is selected.`
    });
  }
  attemptActions.push({
    name: "stagehand-next",
    prompt: "Scroll to the table pagination and click the next page control once."
  });
  if (targetPage) {
    attemptActions.push({
      name: `stagehand-explicit-page-${targetPage}`,
      prompt: `Click page ${targetPage} in the table pagination.`
    });
  }

  for (const attempt of attemptActions) {
    try {
      await stagehand.act(attempt.prompt);
      console.log(`Intento de avance ejecutado por: ${attempt.name}.`);
    } catch (error) {
      console.log(`Intento fallido (${attempt.name}): ${error?.message || "sin detalle"}`);
      continue;
    }

    const changed = await waitForAdvance(20000);
    if (changed) {
      const afterState = await getPaginationState(page).catch(() => null);
      if (afterState) {
        console.log(`Paginación después: actual=${afterState.activeText || "?"}.`);
      }
      await page.waitForTimeout(1200);
      return true;
    }
  }

  const domFallbackClicked = await page.evaluate(() => {
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
      document.querySelectorAll("[class*='pagination'] button, [class*='pagination'] a, [class*='pagination'] [role='button'], .semi-pagination-next")
    );

    for (const control of controls) {
      if (!isVisible(control) || isDisabled(control)) continue;
      const label = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""} ${normalize(control.textContent)}`
        .toLowerCase()
        .trim();
      const className = String(control.className || "").toLowerCase();
      if (
        !label.includes("next") &&
        !label.includes("siguiente") &&
        !label.includes("proxima") &&
        !label.includes("próxima") &&
        !className.includes("pagination-next") &&
        !className.includes("pager-next")
      ) {
        continue;
      }
      control.scrollIntoView({ block: "center", inline: "nearest" });
      control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }
    return false;
  }).catch(() => false);

  if (domFallbackClicked) {
    console.log("Intento de avance ejecutado por: dom-fallback-next.");
    const changed = await waitForAdvance(15000);
    if (changed) {
      const afterState = await getPaginationState(page).catch(() => null);
      if (afterState) {
        console.log(`Paginación después: actual=${afterState.activeText || "?"}.`);
      }
      await page.waitForTimeout(1200);
      return true;
    }
  }

  const afterState = await getPaginationState(page).catch(() => null);
  if (afterState) {
    console.log(`Paginación después: actual=${afterState.activeText || "?"}.`);
  }
  console.log("No se detectó cambio de página tras todos los intentos.");
  return false;
}

async function main() {
  const dateInput = getDateInputFromArgs();
  const cutoffDate = parseInputDate(dateInput);

  if (!cutoffDate) {
    console.error("Fecha inválida o faltante.");
    console.error("Usa uno de estos formatos: --fecha \"2026-04-16\", --fecha \"16/04/2026\", --fecha \"16 de abril\".");
    process.exit(1);
  }

  const now = new Date();
  if (cutoffDate.getTime() > now.getTime()) {
    console.error(
      `La fecha ingresada (${cutoffDate.toLocaleDateString("es-CO")}) está en el futuro. Usa una fecha pasada.`
    );
    process.exit(1);
  }

  const referenceNow = new Date();
  const referenceNowText = formatLocalDateTime(referenceNow);
  const cutoffDateText = cutoffDate.toLocaleDateString("es-CO");
  console.log(`Hora local de referencia: ${formatLocalDateTime(referenceNow)}.`);
  console.log(`Fecha de corte: ${cutoffDate.toLocaleDateString("es-CO")}.`);
  console.log("Regla: cumple si (ahora_local - (7d - estado_de_incorporación)) > fecha_de_corte.");

  const stagehand = new Stagehand({
    env: "LOCAL"
  });

  await stagehand.init();
  console.log("Stagehand Session Started");

  const page = stagehand.context.pages()[0];
  const loginCheckUrl = "https://live-backstage.tiktok.com/portal/anchor/list";

  if (fs.existsSync(AUTH_FILE)) {
    console.log("Restaurando sesión guardada...");
    try {
      const { cookies, origins } = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
      if (cookies?.length) await stagehand.context.addCookies(cookies);
      if (origins?.length) {
        for (const { origin, localStorage: items } of origins) {
          await page.goto(origin);
          await page.evaluate((entries) => {
            for (const { name, value } of entries) window.localStorage.setItem(name, value);
          }, items);
        }
      }
      console.log("Sesión restaurada.");
    } catch (e) {
      console.warn("Error al leer auth.json, iniciando desde cero:", e.message);
      fs.unlinkSync(AUTH_FILE);
    }
  }

  await page.goto(loginCheckUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const isLoggedIn = page.url().includes("live-backstage.tiktok.com/portal");

  if (!isLoggedIn) {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
      console.log("Sesión inválida detectada, auth.json eliminado.");
    }

    console.log("No hay sesión activa, haciendo login...");
    await stagehand.act("Click the 'Login' button.");

    console.log("Completá el login manualmente en el navegador (incluyendo verificación humana)...");
    const loginTimeout = 5 * 60 * 1000;
    const loginStart = Date.now();

    while (!page.url().includes("live-backstage.tiktok.com/portal")) {
      if (Date.now() - loginStart > loginTimeout) {
        console.warn("Timeout esperando login. Guardando estado actual de todas formas...");
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    const cookies = await stagehand.context.cookies();
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
  await setItemsPerPageTo100(stagehand, page);
  await waitForCreatorsTable(page);

  const collected = [];
  const seen = new Set();
  const profileSignalsByKey = new Map();
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

    if (extractedRows.incorporationIndex === -1 && !warnedMissingHeader) {
      console.warn("No encontré header 'Scouting status'; uso detección por contenido de filas.");
      warnedMissingHeader = true;
    }

    const normalizedRows = (extractedRows.data || [])
      .map((p) => ({
        rowIndex: p.rowIndex,
        name: p.name || p.creator || p.creatorName || "",
        incorporationStatus:
          p.scoutingStatus ||
          p.scouting ||
          p.incorporationStatus ||
          p.status ||
          p.incorporacion ||
          p.incorporation ||
          p.estadoIncorporacion ||
          "",
      }))
      .filter((p) => p.name || p.incorporationStatus)
      .map((p) => {
        const remainingMinutes = parseIncorporationToMinutes(p.incorporationStatus);
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
        `- ${p.name || "(sin nombre)"} | scouting status: ${p.incorporationStatus || "(sin dato)"} | hoy: ${referenceNowText} | fecha_aplicación_inferida: ${inferredText} | comparación: ${compareText}`
      );
    }

    const pageMatches = normalizedRows.filter(
      (p) => p.qualifies
    );

    const profileKey = (p) => (p?.name || "").trim().toLowerCase();
    const toInspect = pageMatches.filter(
      (p) => Number.isFinite(p.rowIndex) && !profileSignalsByKey.has(profileKey(p))
    );

    if (toInspect.length) {
      const phoneResults = await checkProfilesForPhone(stagehand, page, toInspect);
      for (const result of phoneResults) {
        const key = (result?.name || "").trim().toLowerCase();
        if (!key) continue;
        profileSignalsByKey.set(key, {
          hasPhone: Boolean(result.hasPhone),
          phone: result.phone || "",
          phones: result.phones || [],
          inviteStatus: result.inviteStatus || "unknown",
          inviteAvailable: result.inviteAvailable ?? null,
          inviteClicked: Boolean(result.inviteClicked),
          inviteDetail: result.inviteDetail || ""
        });
      }
      await waitForCreatorsTable(page).catch(() => null);
    }

    for (const p of pageMatches) {
      const key = `${p.name}||${p.incorporationStatus}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const phoneInfo = profileSignalsByKey.get(profileKey(p)) || {
        hasPhone: false,
        phone: "",
        phones: [],
        inviteStatus: "unknown",
        inviteAvailable: null,
        inviteClicked: false,
        inviteDetail: ""
      };
      collected.push({
        ...p,
        hasPhone: phoneInfo.hasPhone,
        phone: phoneInfo.phone,
        phones: phoneInfo.phones,
        inviteStatus: phoneInfo.inviteStatus,
        inviteAvailable: phoneInfo.inviteAvailable,
        inviteClicked: phoneInfo.inviteClicked,
        inviteDetail: phoneInfo.inviteDetail
      });
    }

    const comparableRows = normalizedRows.filter((p) => Number.isFinite(p.remainingMinutes));
    const lastRow = comparableRows[comparableRows.length - 1] || normalizedRows[normalizedRows.length - 1];
    const lastMinutes = lastRow?.remainingMinutes;
    const lastQualifies = Boolean(lastRow?.qualifies);

    const minutesLabel = Number.isFinite(lastMinutes) ? ` (${formatMinutesAsDhM(lastMinutes)})` : "";
    const appliedAtLabel = lastRow?.appliedAtText ? ` -> aplicada: ${lastRow.appliedAtText}` : "";
    console.log(
      `Página ${pageIndex}: ${normalizedRows.length} filas, ${pageMatches.length} cumplen. Último: ${lastRow.incorporationStatus}${minutesLabel}${appliedAtLabel}.`
    );

    if (!lastQualifies) {
      console.log("El último item ya no cumple la fecha de corte. Se detiene la paginación.");
      break;
    }

    let moved = false;
    const maxAdvanceRetries = 3;
    for (let advanceAttempt = 1; advanceAttempt <= maxAdvanceRetries; advanceAttempt += 1) {
      moved = await goToNextPage(stagehand, page, pageIndex + 1);
      if (moved) break;
      if (advanceAttempt < maxAdvanceRetries) {
        console.warn(`No se detectó avance en intento ${advanceAttempt}/${maxAdvanceRetries}. Reintentando...`);
        await page.waitForTimeout(1200);
      }
    }

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
        `- ${p.name} | scouting status: ${p.incorporationStatus} | hoy: ${referenceNowText} | fecha_aplicación_inferida: ${p.appliedAtText} | comparación: ${p.appliedAtText} > ${cutoffDateText} = ${p.qualifies} | dejó_tel=${p.hasPhone} | teléfono=${phoneText} | invite=${p.inviteStatus}`
      );
    }
  }

  await stagehand.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
