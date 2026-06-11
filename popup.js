const copyButton = document.getElementById("copyButton");
const docsButton = document.getElementById("docsButton");
const statusText = document.getElementById("status");

const EMPTY_TEXT = "（未入力）";
const UNKNOWN_QUESTION = "設問不明";

copyButton.addEventListener("click", async () => {
  setStatus("ページを解析しています...", "");
  copyButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("現在のタブを取得できませんでした。");
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectFormBackup,
      args: [EMPTY_TEXT, UNKNOWN_QUESTION]
    });

    if (!result || result.count === 0) {
      throw new Error("取得できる設問が見つかりませんでした。");
    }

    await navigator.clipboard.writeText(result.text);
    setStatus(`✓ ${result.count}件の設問をコピーしました`, "success");
  } catch (error) {
    setStatus(error?.message || "コピーに失敗しました。", "error");
  } finally {
    copyButton.disabled = false;
  }
});

docsButton.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://docs.new" });
});

function setStatus(message, type) {
  statusText.textContent = message;
  statusText.className = type ? `status ${type}` : "status";
}

function collectFormBackup(emptyText, unknownQuestion) {
  const controlIds = new WeakMap();
  let nextControlId = 1;
  const supportedSelector = [
    "input[type='text']",
    "input[type='email']",
    "input[type='number']",
    "input[type='tel']",
    "input[type='url']",
    "input[type='search']",
    "input[type='date']",
    "input[type='datetime-local']",
    "input[type='time']",
    "input[type='radio']",
    "input[type='checkbox']",
    "input[type='file']",
    "input:not([type])",
    "textarea",
    "select"
  ].join(",");

  const controls = Array.from(document.querySelectorAll(supportedSelector))
    .filter((control) => !isExcluded(control));
  const groups = [];
  const groupedControlIds = new Set();

  for (const control of controls) {
    if (groupedControlIds.has(getControlId(control))) {
      continue;
    }

    if (isChoice(control)) {
      const groupControls = getChoiceGroup(control, controls);
      groupControls.forEach((item) => groupedControlIds.add(getControlId(item)));
      groups.push({
        element: firstVisibleElement(groupControls) || control,
        controls: groupControls,
        question: getQuestion(control, groupControls, unknownQuestion),
        answer: getChoiceAnswer(groupControls, emptyText)
      });
      continue;
    }

    groups.push({
      element: control,
      controls: [control],
      question: getQuestion(control, [control], unknownQuestion),
      answer: getAnswer(control, emptyText)
    });
  }

  groups.sort((a, b) => {
    const position = a.element.compareDocumentPosition(b.element);
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    return 0;
  });

  const questionCounts = new Map();
  const sections = groups.map((group) => {
    const question = addDuplicateNumber(group.question, questionCounts);
    const answer = group.answer || emptyText;
    const characterCount = countAnswerCharacters(answer, emptyText);
    const characterCountLine = characterCount >= 100 ? `\n（文字数：${characterCount}字）` : "";
    return `【${question}】\n${answer}${characterCountLine}`;
  });
  const pageInfoSections = getPageInfoSections();

  return {
    count: sections.length,
    text: [...pageInfoSections, ...sections].join("\n\n")
  };

  function isExcluded(control) {
    if (control.disabled) return true;
    if (control.matches("input")) {
      const type = (control.getAttribute("type") || "text").toLowerCase();
      return ["password", "hidden", "submit", "button", "reset"].includes(type);
    }
    return false;
  }

  function isChoice(control) {
    return control.matches("input[type='radio'], input[type='checkbox']");
  }

  function getChoiceGroup(control, allControls) {
    const type = control.type;
    const name = control.getAttribute("name");
    if (!name) {
      return [control];
    }

    const form = control.form;
    return allControls.filter((item) => {
      return item.type === type &&
        item.getAttribute("name") === name &&
        item.form === form;
    });
  }

  function getQuestion(control, groupControls, fallback) {
    const candidates = [
      getLabelText(control, groupControls),
      control.getAttribute("aria-label"),
      getHeadingText(control),
      getTableHeaderText(control),
      getNearbyText(control, groupControls)
    ];

    const question = candidates
      .map(normalizeText)
      .find((text) => text.length > 0);
    return question || fallback;
  }

  function getLabelText(control, groupControls) {
    const directLabels = groupControls
      .flatMap((item) => Array.from(item.labels || []))
      .map((label) => labelTextWithoutNestedControls(label, groupControls))
      .filter(Boolean);
    if (directLabels.length > 0) {
      return commonQuestionText(directLabels) || directLabels[0];
    }

    const wrappingLabel = control.closest("label");
    if (wrappingLabel) {
      return labelTextWithoutNestedControls(wrappingLabel, groupControls);
    }

    return "";
  }

  function labelTextWithoutNestedControls(label, ownControls) {
    const clone = label.cloneNode(true);
    clone.querySelectorAll("input, textarea, select, button, option").forEach((node) => {
      node.remove();
    });
    return clone.textContent;
  }

  function commonQuestionText(labels) {
    if (labels.length <= 1) return labels[0] || "";
    const normalized = labels.map(normalizeText);
    const shortest = normalized.reduce((a, b) => (a.length <= b.length ? a : b), normalized[0]);
    if (normalized.every((text) => text === shortest)) {
      return shortest;
    }
    return "";
  }

  function getHeadingText(control) {
    let current = control.parentElement;
    while (current && current !== document.body) {
      const heading = current.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading && isBeforeOrContains(heading, control)) {
        return heading.textContent;
      }
      current = current.parentElement;
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .filter((heading) => isBefore(heading, control));
    return headings.at(-1)?.textContent || "";
  }

  function getTableHeaderText(control) {
    const cell = control.closest("td, th");
    if (!cell) return "";
    const row = cell.closest("tr");
    const rowHeader = row?.querySelector("th");
    if (rowHeader && rowHeader !== cell) {
      return rowHeader.textContent;
    }

    const table = control.closest("table");
    if (!table || !row) return "";
    const cellIndex = Array.from(row.children).indexOf(cell);
    const headerRow = Array.from(table.querySelectorAll("tr"))
      .find((candidateRow) => candidateRow !== row && candidateRow.querySelectorAll("th").length > 0);
    return headerRow?.children?.[cellIndex]?.textContent || "";
  }

  function getNearbyText(control, groupControls) {
    const fieldsetLegend = control.closest("fieldset")?.querySelector("legend");
    if (fieldsetLegend) {
      return fieldsetLegend.textContent;
    }

    const container = findQuestionContainer(control);
    if (!container) return "";

    const clone = container.cloneNode(true);
    clone.querySelectorAll("input, textarea, select, button, option, script, style").forEach((node) => {
      node.remove();
    });

    const text = normalizeText(clone.textContent);
    const answerLabels = groupControls
      .flatMap((item) => Array.from(item.labels || []))
      .map((label) => normalizeText(label.textContent))
      .filter(Boolean);

    return answerLabels.reduce((remaining, label) => remaining.replace(label, "").trim(), text);
  }

  function findQuestionContainer(control) {
    let current = control.parentElement;
    while (current && current !== document.body) {
      const nestedControls = current.querySelectorAll(supportedSelector).length;
      const text = normalizeText(current.textContent);
      if (text && nestedControls <= 8) {
        return current;
      }
      current = current.parentElement;
    }
    return control.parentElement;
  }

  function getAnswer(control, fallback) {
    if (control.matches("textarea")) {
      return control.value || fallback;
    }

    if (control.matches("select")) {
      const selected = Array.from(control.selectedOptions)
        .map((option) => normalizeText(option.textContent || option.value))
        .filter(Boolean);
      return selected.length > 0 ? selected.join(", ") : fallback;
    }

    if (control.matches("input[type='file']")) {
      const files = Array.from(control.files || []).map((file) => file.name).filter(Boolean);
      return files.length > 0 ? files.join(", ") : fallback;
    }

    return control.value || fallback;
  }

  function getChoiceAnswer(groupControls, fallback) {
    const checked = groupControls.filter((control) => control.checked);
    if (checked.length === 0) return fallback;
    return checked.map(getChoiceLabelOrValue).filter(Boolean).join(", ") || fallback;
  }

  function getChoiceLabelOrValue(control) {
    const label = Array.from(control.labels || [])
      .map((item) => labelTextWithoutNestedControls(item, [control]))
      .map(normalizeText)
      .find(Boolean);
    return label || control.value || "";
  }

  function addDuplicateNumber(question, counts) {
    const count = (counts.get(question) || 0) + 1;
    counts.set(question, count);
    return count === 1 ? question : `${question}(${count})`;
  }

  function countAnswerCharacters(answer, fallback) {
    if (!answer || answer === fallback) return 0;
    return Array.from(String(answer).replace(/\r\n/g, "\n")).length;
  }

  function getPageInfoSections() {
    const sources = getPageInfoSources();
    const companyName = detectCompanyName(sources);
    const internName = detectInternName(sources);
    return [buildDocumentTitle(companyName, internName)];
  }

  function buildDocumentTitle(companyName, internName) {
    const titleParts = [companyName, internName, `${getCurrentDateText()}保存版`]
      .map(cleanTitlePart)
      .filter(Boolean);
    return titleParts.join("/");
  }

  function getCurrentDateText() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function cleanTitlePart(text) {
    return normalizeText(text).replace(/[\\/:*?"<>|]/g, " ").trim();
  }

  function getPageInfoSources() {
    const metaSelectors = [
      "meta[property='og:site_name']",
      "meta[property='og:title']",
      "meta[name='application-name']",
      "meta[name='title']",
      "meta[name='description']"
    ];
    const metaTexts = metaSelectors
      .map((selector) => document.querySelector(selector)?.content)
      .filter(Boolean);
    const headingTexts = Array.from(document.querySelectorAll("h1, h2, h3"))
      .slice(0, 12)
      .map((heading) => heading.textContent);
    const logoTexts = Array.from(document.querySelectorAll("img[alt], [aria-label]"))
      .slice(0, 20)
      .map((element) => element.getAttribute("alt") || element.getAttribute("aria-label"));

    return [document.title, ...metaTexts, ...headingTexts, ...logoTexts]
      .map(normalizeText)
      .filter(Boolean);
  }

  function detectCompanyName(sources) {
    const legalFormPattern = /(?:株式会社|有限会社|合同会社|学校法人|医療法人)\s*[^｜|:：\-–—【】「」()（）\[\]\s]{1,40}|[^｜|:：\-–—【】「」()（）\[\]\s]{1,40}\s*(?:株式会社|有限会社|合同会社|Inc\.?|Corporation|Corp\.?|Ltd\.?|LLC)/i;

    for (const source of sources) {
      const match = source.match(legalFormPattern);
      if (match) {
        return cleanPageInfoText(match[0]);
      }
    }

    for (const source of sources) {
      const segments = splitPageInfoSegments(source);
      const candidate = segments.find(isLikelyCompanyName);
      if (candidate) {
        return candidate;
      }
    }

    return "";
  }

  function detectInternName(sources) {
    const internPattern = /[^｜|。:：]{0,35}(?:インターンシップ|インターン|Internship|Intern)[^｜|。:：]{0,45}/i;

    for (const source of sources) {
      const candidate = splitPageInfoSegments(source).find((segment) => internPattern.test(segment));
      if (candidate && !isGenericPageInfo(candidate)) {
        return candidate;
      }
    }

    for (const source of sources) {
      const fallbackMatch = source.match(internPattern);
      if (fallbackMatch) {
        const candidate = cleanPageInfoText(fallbackMatch[0]);
        if (candidate && !isGenericPageInfo(candidate)) {
          return candidate;
        }
      }
    }

    return "";
  }

  function splitPageInfoSegments(text) {
    return String(text)
      .split(/[|｜\-–—:：]/)
      .map(cleanPageInfoText)
      .filter(Boolean);
  }

  function cleanPageInfoText(text) {
    return normalizeText(text)
      .replace(/^[\s「『【\[(]+|[\s」』】\])]+$/g, "")
      .replace(/\s*(採用情報|新卒採用|中途採用|マイページ|応募フォーム|エントリーシート|ES)$/i, "")
      .trim();
  }

  function isLikelyCompanyName(text) {
    const candidate = cleanPageInfoText(text);
    if (candidate.length < 2 || candidate.length > 40) return false;
    if (isGenericPageInfo(candidate)) return false;
    if (/(採用|応募|エントリー|フォーム|アンケート|ログイン|マイページ|インターン|説明会|選考|ES)$/i.test(candidate)) {
      return false;
    }
    return /[一-龠ぁ-んァ-ヶA-Za-z0-9]/.test(candidate);
  }

  function isGenericPageInfo(text) {
    return /^(採用情報|新卒採用|中途採用|応募|応募フォーム|エントリー|エントリーシート|ES|フォーム|アンケート|ログイン|マイページ|My Page|Recruit|Careers?)$/i
      .test(cleanPageInfoText(text));
  }

  function firstVisibleElement(items) {
    return items.find((item) => item.offsetParent !== null) || items[0];
  }

  function getControlId(control) {
    if (!controlIds.has(control)) {
      controlIds.set(control, nextControlId);
      nextControlId += 1;
    }
    return controlIds.get(control);
  }

  function isBefore(a, b) {
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isBeforeOrContains(a, b) {
    return a === b || a.contains(b) || isBefore(a, b);
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }
}
