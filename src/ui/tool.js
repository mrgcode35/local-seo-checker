/**
 * Browser UI for the Local SEO Checker. No dependencies; talks to the service at
 * `apiUrl` (POST JSON). All page/user text is written with textContent.
 */
const STATUS_LABEL = { fail: 'Fix', warn: 'Improve', pass: 'Good', skip: 'Skipped' };
const ORDER = { fail: 0, warn: 1, pass: 2, skip: 3 };

/**
 * @param {HTMLElement} root
 * @param {{ apiUrl?: string }} [options]
 */
export function mountLocalSeoChecker(root, options = {}) {
  const apiUrl = options.apiUrl || '/check';
  root.classList.add('lsc');
  // Static structure only.
  root.innerHTML = `
    <form class="lsc-panel lsc-form" novalidate>
      <label class="lsc-label" for="lsc-url">Page to check *</label>
      <div class="lsc-row">
        <input id="lsc-url" class="lsc-input" name="url" type="text" inputmode="url" autocomplete="url" spellcheck="false"
               placeholder="example.com or https://example.com/plumber-springfield/" required />
        <button class="lsc-btn lsc-btn-primary lsc-submit" type="submit">Check page</button>
      </div>
      <details class="lsc-more">
        <summary>Add business name, city and service (optional, for extra checks)</summary>
        <div class="lsc-3">
          <div><label class="lsc-label" for="lsc-name">Business name</label><input id="lsc-name" class="lsc-input" name="name" type="text" maxlength="80" placeholder="Acme Plumbing" /></div>
          <div><label class="lsc-label" for="lsc-city">City</label><input id="lsc-city" class="lsc-input" name="city" type="text" maxlength="80" placeholder="Springfield" /></div>
          <div><label class="lsc-label" for="lsc-service">Main service</label><input id="lsc-service" class="lsc-input" name="service" type="text" maxlength="80" placeholder="Plumber" /></div>
        </div>
      </details>
      <p class="lsc-error" role="alert" hidden></p>
      <p class="lsc-loading" hidden aria-live="polite"><span class="lsc-spinner" aria-hidden="true"></span> Checking the page… this usually takes 5–15 seconds.</p>
    </form>

    <section class="lsc-results" hidden aria-live="polite">
      <div class="lsc-report">
        <div class="lsc-panel lsc-summary">
          <div class="lsc-gauge" role="img"><span class="lsc-score"></span><span class="lsc-grade"></span></div>
          <div class="lsc-summary-text">
            <h3 class="lsc-h">Local SEO score</h3>
            <p class="lsc-page"></p>
            <p class="lsc-date"></p>
            <div class="lsc-cats"></div>
          </div>
        </div>
        <div class="lsc-panel">
          <h3 class="lsc-h">What to fix first</h3>
          <ol class="lsc-checks"></ol>
        </div>
      </div>
      <div class="lsc-row lsc-row-center lsc-actions">
        <button class="lsc-btn lsc-btn-primary lsc-print" type="button">Print / Save report as PDF</button>
        <button class="lsc-btn lsc-again" type="button">Check another page</button>
      </div>
      <p class="lsc-note">The report has no third-party branding, so agencies can share it with clients.</p>
    </section>
  `;

  const $ = (s) => root.querySelector(s);
  const form = $('.lsc-form');
  const field = (n) => form.elements.namedItem(n);
  const error = $('.lsc-error');
  const loading = $('.lsc-loading');
  const submit = $('.lsc-submit');
  const results = $('.lsc-results');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = field('url').value.trim();
    if (!url) { showError('Enter the address of the page you want to check.'); return; }
    showError('');
    loading.hidden = false;
    submit.disabled = true;
    results.hidden = true;
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name: field('name').value, city: field('city').value, service: field('service').value }),
      });
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) {
        showError(data?.error?.message || `The checker couldn't complete (HTTP ${res.status}). Please try again.`);
        return;
      }
      render(data.result);
      results.hidden = false;
      results.scrollIntoView({ behavior: 'smooth', block: 'start' });
      root.dispatchEvent(new CustomEvent('lsc:checked', { bubbles: true, detail: { score: data.result.score } }));
    } catch {
      showError('We couldn\'t reach the checker. Check your connection and try again.');
    } finally {
      loading.hidden = true;
      submit.disabled = false;
    }
  });

  $('.lsc-print').addEventListener('click', () => {
    document.body.classList.add('lsc-printing');
    window.print();
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('lsc-printing'));
  $('.lsc-again').addEventListener('click', () => {
    results.hidden = true;
    field('url').focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function showError(msg) {
    error.textContent = msg;
    error.hidden = !msg;
  }

  function render(r) {
    const gauge = $('.lsc-gauge');
    gauge.style.setProperty('--lsc-pct', String(r.score));
    gauge.dataset.grade = r.grade;
    gauge.setAttribute('aria-label', `Score ${r.score} out of 100, grade ${r.grade}`);
    $('.lsc-score').textContent = String(r.score);
    $('.lsc-grade').textContent = `Grade ${r.grade}`;
    $('.lsc-page').textContent = r.finalUrl;
    $('.lsc-date').textContent = `Checked ${new Date(r.checkedAt).toLocaleString()}`;

    const cats = $('.lsc-cats');
    cats.replaceChildren(...r.categories.filter((c) => c.score !== null).map((c) => {
      const row = el('div', 'lsc-cat');
      row.append(el('span', 'lsc-cat-name', c.label));
      const bar = el('span', 'lsc-bar');
      const fill = el('span', 'lsc-bar-fill');
      fill.style.width = `${c.score}%`;
      fill.dataset.level = c.score >= 75 ? 'good' : c.score >= 50 ? 'mid' : 'low';
      bar.append(fill);
      row.append(bar, el('span', 'lsc-cat-score', String(c.score)));
      return row;
    }));

    const list = $('.lsc-checks');
    const sorted = [...r.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    list.replaceChildren(...sorted.map((c) => {
      const li = el('li', `lsc-check lsc-check--${c.status}`);
      const head = el('div', 'lsc-check-head');
      head.append(el('span', `lsc-badge lsc-badge--${c.status}`, STATUS_LABEL[c.status] || c.status), el('strong', 'lsc-check-title', c.title));
      li.append(head, el('p', 'lsc-check-detail', c.detail));
      if (c.fix && (c.status === 'fail' || c.status === 'warn')) li.append(el('p', 'lsc-check-fix', `How to fix: ${c.fix}`));
      return li;
    }));
  }

  return { render };
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
