// Pagina Storico: mostra l'evoluzione di una lettera su una specifica emozione,
// usando gli stessi dati (localStorage) e le stesse funzioni dell'editor
// (store, community, interpolateGlyph, meanDeltas, applyDeltas, drawGlyphThumb).
(function () {
  if (!document.getElementById("history-letters")) return;

  let container = null;
  let activeChar = null;
  let activeEmotion = null;

  function emotionWeights(e) {
    return store.emotions.map((x) => (x === e ? 1 : 0));
  }

  function renderHistory(ch, emotion) {
    const head = $("history-heading");
    if (head) head.textContent = `Storico di «${ch}» · ${emotion.id}`;
    const norm = store.normalizeChar(ch);
    const base = interpolateGlyph(store.glyphsForChar(norm), emotionWeights(emotion));
    const list = community.listContributions(ch, emotion.id);
    const steps = [];
    steps.push({ label: "Originale", contours: base.contours });
    for (let k = 1; k <= list.length; k++) {
      const d = meanDeltas(list.slice(0, k));
      steps.push({ label: `Contributo ${k}`, contours: applyDeltas(base.contours, d) });
    }
    const listEl = $("history-list");
    listEl.textContent = "";
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "Nessun contributo ancora salvato per questa lettera su questa emozione.";
      listEl.appendChild(empty);
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const fig = document.createElement("figure");
      fig.className = "history-step";
      if (i === steps.length - 1) fig.classList.add("current");
      const cv = document.createElement("canvas");
      cv.width = 118; cv.height = 118;
      cv.setAttribute("aria-label", st.label);
      drawGlyphThumb(cv, st.contours, emotion.color);
      const cap = document.createElement("figcaption");
      cap.textContent = st.label;
      fig.appendChild(cv);
      fig.appendChild(cap);
      listEl.appendChild(fig);
    }
  }

  function updateBadges() {
    const letterChips = container.querySelectorAll(".letter-chip");
    letterChips.forEach((b) => {
      const badge = b.querySelector(".letter-badge");
      if (!badge) return;
      const ch = b.dataset.char;
      const n = activeEmotion ? community.contributionCount(ch, activeEmotion.id) : 0;
      if (n > 0) {
        badge.textContent = n;
        badge.classList.add("show");
      } else {
        badge.textContent = "";
        badge.classList.remove("show");
      }
    });
  }

  async function init() {
    await store.load();
    container = $("history-letters");
    const emotions = store.visibleEmotions;
    const letterChips = [];
    const firstWith = [];
    const ua = (store.meta && store.meta.upperAccents) || {};
    for (const ch of store.charset) {
      if (ch === " ") continue;
      const b = document.createElement("button");
      b.className = "letter-chip";
      b.setAttribute("type", "button");
      b.textContent = ua[ch] || ch;
      b.dataset.char = ch;
      b.setAttribute("aria-label", `Lettera ${ua[ch] || ch}`);
      const badge = document.createElement("span");
      badge.className = "letter-badge";
      b.appendChild(badge);
      b.addEventListener("click", () => {
        letterChips.forEach((c) => c.classList.remove("active"));
        b.classList.add("active");
        activeChar = ch;
        if (!activeEmotion) activeEmotion = emotions[0];
        renderHistory(activeChar, activeEmotion);
      });
      container.appendChild(b);
      letterChips.push(b);
      if (Object.keys(community.countsByEmotion(ch)).length > 0) firstWith.push(b);
    }

    const emoContainer = $("history-emotions");
    const emoChips = [];
    emotions.forEach((e) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.setAttribute("type", "button");
      b.dataset.id = e.id;
      b.style.setProperty("--c", e.color);
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = e.color;
      b.appendChild(dot);
      b.appendChild(document.createTextNode(e.id));
      b.addEventListener("click", () => {
        emoChips.forEach((c) => c.classList.remove("active"));
        b.classList.add("active");
        activeEmotion = e;
        updateBadges();
        if (activeChar) renderHistory(activeChar, activeEmotion);
        updateEmotionTheme({ emotionId: e.id, color: e.color });
      });
      emoContainer.appendChild(b);
      emoChips.push(b);
    });

    const defaultLetter = firstWith[0] || letterChips[0];
    if (defaultLetter) defaultLetter.click();

    const counts = activeChar ? community.countsByEmotion(activeChar) : {};
    const firstEmoId = Object.keys(counts)[0];
    const firstEmo = emotions.find((e) => e.id === firstEmoId) || emotions[0];
    const firstEmoChip = emoChips.find((c) => c.dataset.id === firstEmo.id) || emoChips[0];
    if (firstEmoChip) firstEmoChip.click();
  }

  init().catch((e) => console.error(e));
})();