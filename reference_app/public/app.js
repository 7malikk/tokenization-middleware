// Demonstration page. Plain JavaScript, no dependencies.
//
// The BVN is never stored in the browser: no localStorage, sessionStorage or
// cookies, and it is never logged. A revealed BVN lives in one variable and one
// DOM node for 10 seconds, then both are cleared.
'use strict';

const REVEAL_MS = 10_000;
const TRAIL_MS = 3_600;
const byId = (id) => document.getElementById(id);

let latestVault = { records: [], audit: [] };
let customers = [];
let erasedBefore = null;
let revealed = null; // { customerId, fullName, value, shownAt }
let revealTimer = null;
let tracedToken = null;
let trailToken = null;
let trailTimer = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** Eleven random digits from the browser's CSPRNG. Synthetic, for the demo only. */
function syntheticBvn() {
  const values = new Uint32Array(11);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => String(v % 10)).join('');
}

function short(token) {
  return token.length > 16 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token;
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tok(token) {
  const span = el('span', 'tok', short(token));
  span.title = token;
  return span;
}

function td(className, ...children) {
  const cell = el('td', className);
  cell.append(...children);
  return cell;
}

function button(label, className, onClick) {
  const b = el('button', `btn btn-sm ${className}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Tag a row with its token so hover tracing and the action trail can find it. */
function marked(node, token) {
  if (!token) return node;
  node.dataset.token = token;
  if (token === tracedToken) node.classList.add('traced');
  if (token === trailToken) node.classList.add('trail');
  return node;
}

function emptyRow(columns, text) {
  const tr = el('tr', 'empty');
  const cell = el('td', '', text);
  cell.colSpan = columns;
  tr.append(cell);
  return tr;
}

/* Narration: one plain sentence about what just happened. Parts are strings or { token }. */

function narrate(op, isError, ...parts) {
  const box = byId('status').parentElement;
  byId('status-op').textContent = op;
  byId('status').replaceChildren(...parts.map((p) => (typeof p === 'string' ? p : tok(p.token))));
  box.classList.toggle('error', isError);
  box.classList.remove('enter');
  void box.offsetWidth;
  box.classList.add('enter');
}

/* Ledgers */

function renderCustomers() {
  // Newest first, using the vault's creation times (the app table has no timestamp).
  const created = new Map(latestVault.records.map((r) => [r.token, r.createdAt]));
  const erased = new Set(latestVault.records.filter((r) => r.erasedAt).map((r) => r.token));
  const sorted = [...customers].sort((a, b) => (created.get(b.bvnToken) ?? '').localeCompare(created.get(a.bvnToken) ?? ''));

  const rows = [];
  for (const c of sorted) {
    const isErased = erased.has(c.bvnToken);
    const name = td('name', c.fullName);
    name.title = `id ${c.id}`;
    const tokenCell = td('', tok(c.bvnToken));
    if (isErased) tokenCell.append(el('span', 'dead', 'erased'));

    const reveal = button('Reveal', 'btn-secondary', () => revealBvn(c));
    reveal.setAttribute('aria-label', `Reveal the BVN for ${c.fullName}`);
    const erase = button(isErased ? 'Erased' : 'Erase', 'btn-danger', () => eraseBvn(c));
    erase.setAttribute('aria-label', `Erase the BVN for ${c.fullName}`);
    erase.disabled = isErased;

    const tr = marked(el('tr'), c.bvnToken);
    tr.append(name, tokenCell, td('actions', reveal, erase));
    rows.push(tr);
    if (revealed && revealed.customerId === c.id) rows.push(revealRow());
  }

  byId('customers-body').replaceChildren(
    ...(rows.length ? rows : [emptyRow(3, 'No customers yet. Enter a name above, generate a BVN and tokenize it.')]),
  );
  byId('app-count').textContent = `${customers.length} ${customers.length === 1 ? 'row' : 'rows'}`;
}

function revealRow() {
  const tr = el('tr', 'reveal-row');
  const box = el('div', 'reveal');
  const timer = el('span', 'reveal-timer');
  const bar = el('span');
  // Keep the countdown in step with the real timer when the table is redrawn.
  bar.style.animationDelay = `-${Date.now() - revealed.shownAt}ms`;
  timer.append(bar);
  box.append(
    el('span', 'reveal-label', `BVN for ${revealed.fullName}, detokenized by the middleware. Synthetic; cleared after 10 seconds.`),
    el('output', 'reveal-value', revealed.value),
    timer,
    button('Hide now', 'btn-secondary', hideRevealed),
  );
  const cell = el('td');
  cell.colSpan = 3;
  cell.append(box);
  tr.append(cell);
  return tr;
}

function renderVault() {
  const erasedNow = new Set(latestVault.records.filter((r) => r.erasedAt).map((r) => r.token));
  const items = latestVault.records.map((r) => {
    const li = marked(el('li', 'record'), r.token);
    if (r.erasedAt) li.classList.add('erased');
    if (r.erasedAt && erasedBefore && !erasedBefore.has(r.token)) li.classList.add('just-erased');

    const head = el('div', 'record-head');
    head.append(
      tok(r.token),
      el('span', 'record-meta', r.erasedAt ? `erased ${clock(r.erasedAt)}` : `${r.dataType} · master key v${r.masterKeyVersion}`),
    );

    const bytes = el('dl', 'bytes');
    const field = (label, value) => {
      const dd = el('dd');
      if (typeof value === 'string') {
        dd.textContent = value;
        dd.title = value;
      } else {
        dd.append(value);
      }
      bytes.append(el('dt', '', label), dd);
    };
    field('ciphertext', r.ciphertext);
    field('iv · auth tag', `${r.iv} · ${r.authTag}`);
    field('wrapped key', r.wrappedDataKey ?? el('span', 'redacted', 'KEY DESTROYED'));

    li.append(head, bytes);
    return li;
  });
  erasedBefore = erasedNow;

  if (items.length === 0) items.push(el('li', 'empty', 'The vault holds no records for this application yet.'));
  byId('vault-list').replaceChildren(...items);
  const n = latestVault.records.length;
  byId('vault-count').textContent = `${n} ${n === 1 ? 'record' : 'records'}${erasedNow.size ? `, ${erasedNow.size} erased` : ''}`;
}

function renderAudit() {
  const hideInspect = byId('hide-inspect').checked;
  const rows = latestVault.audit
    .filter((a) => !(hideInspect && a.operation === 'INSPECT'))
    .map((a) => {
      const tr = marked(el('tr'), a.token);
      tr.append(
        td('time', clock(a.occurredAt)),
        td('op', a.operation),
        td('', el('span', a.outcome === 'SUCCESS' ? 'outcome' : 'outcome refused', a.outcome)),
        td('', a.token ? tok(a.token) : ''),
      );
      return tr;
    });
  byId('audit-body').replaceChildren(...(rows.length ? rows : [emptyRow(4, 'No audit rows to show yet.')]));
}

async function refresh() {
  const [list, vault] = await Promise.all([api('GET', '/customers'), api('GET', '/demo/vault')]);
  if (vault.status === 200 && vault.data) {
    latestVault = vault.data;
  } else {
    narrate('Error', true, 'Could not read the vault view from the middleware. Check that it is running, then reload.');
  }
  if (list.status === 200 && Array.isArray(list.data)) {
    customers = list.data;
  } else {
    narrate('Error', true, 'Could not read the customer table. Check the app database, then reload.');
  }
  renderVault();
  renderAudit();
  renderCustomers();
}

/* Tracing */

function trace(token) {
  tracedToken = token;
  for (const node of document.querySelectorAll('[data-token]')) {
    node.classList.toggle('traced', token !== null && node.dataset.token === token);
  }
}

/** Mark the token an action touched in every ledger, then let the mark fade. */
function trail(token) {
  trailToken = token;
  clearTimeout(trailTimer);
  trailTimer = setTimeout(() => {
    trailToken = null;
    for (const node of document.querySelectorAll('.trail')) node.classList.remove('trail');
  }, TRAIL_MS);
}

/* Actions */

function hideRevealed() {
  revealed = null;
  for (const row of document.querySelectorAll('.reveal-row')) row.remove();
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
}

async function revealBvn(customer) {
  hideRevealed();
  trail(customer.bvnToken);
  const res = await api('POST', `/customers/${customer.id}/reveal-bvn`);
  if (res.status === 200 && res.data && typeof res.data.bvn === 'string') {
    revealed = { customerId: customer.id, fullName: customer.fullName, value: res.data.bvn, shownAt: Date.now() };
    revealTimer = setTimeout(hideRevealed, REVEAL_MS);
    narrate('Detokenize', false, `Detokenized ${customer.fullName}'s token `, { token: customer.bvnToken }, '. The owner check passed and the audit log recorded SUCCESS.');
  } else if (res.status === 404) {
    narrate('Detokenize', true, `The vault answered "not found" for `, { token: customer.bvnToken }, '. The client learns nothing more; the audit log records the true reason.');
  } else {
    narrate('Detokenize', true, 'Reveal failed. The middleware did not return a BVN.');
  }
  await refresh();
}

async function eraseBvn(customer) {
  hideRevealed();
  trail(customer.bvnToken);
  const res = await api('POST', `/customers/${customer.id}/erase`);
  if (res.status === 200) {
    narrate('Erase', false, 'Erased ', { token: customer.bvnToken }, '. Its wrapped data key is destroyed. The ciphertext stays in the vault but can never be decrypted.');
  } else {
    narrate('Erase', true, 'Erase failed. The vault record is unchanged.');
  }
  await refresh();
}

async function createCustomer(event) {
  event.preventDefault();
  const nameField = byId('full-name');
  const bvnField = byId('bvn');
  const fullName = nameField.value.trim();
  const nameOk = fullName.length > 0;
  const bvnOk = /^[0-9]{11}$/.test(bvnField.value);
  nameField.setAttribute('aria-invalid', String(!nameOk));
  bvnField.setAttribute('aria-invalid', String(!bvnOk));
  if (!nameOk || !bvnOk) {
    narrate('Tokenize', true, !nameOk ? 'Enter the customer\'s full name first.' : 'Press Generate to create a synthetic BVN first.');
    (nameOk ? byId('generate') : nameField).focus();
    return;
  }

  const submit = byId('create');
  submit.disabled = true;
  submit.classList.add('busy');
  const res = await api('POST', '/customers', { fullName, bvn: bvnField.value });
  // Do not keep the BVN on the page once it has been sent.
  bvnField.value = '';
  submit.disabled = false;
  submit.classList.remove('busy');
  if (res.status === 201 && res.data) {
    nameField.value = '';
    trail(res.data.bvnToken);
    narrate('Tokenize', false, `Tokenized ${fullName}'s BVN. The app stored only the token `, { token: res.data.bvnToken }, '; the vault holds the ciphertext.');
  } else {
    narrate('Tokenize', true, 'Create failed. Nothing was stored in either database.');
  }
  await refresh();
}

document.addEventListener('DOMContentLoaded', () => {
  byId('generate').addEventListener('click', () => {
    const field = byId('bvn');
    field.value = syntheticBvn();
    field.removeAttribute('aria-invalid');
    field.classList.remove('filled');
    void field.offsetWidth;
    field.classList.add('filled');
  });
  byId('full-name').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));
  byId('create-form').addEventListener('submit', createCustomer);
  byId('hide-inspect').addEventListener('change', renderAudit);

  const ledgers = byId('ledgers');
  ledgers.addEventListener('mouseover', (e) => {
    const node = e.target.closest('[data-token]');
    if (node && node.dataset.token !== tracedToken) trace(node.dataset.token);
  });
  ledgers.addEventListener('mouseleave', () => trace(null));
  ledgers.addEventListener('mouseout', (e) => {
    const next = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('[data-token]') : null;
    if (!next) trace(null);
  });

  refresh();
});
