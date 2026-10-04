// Demonstration page. Plain JavaScript, no dependencies.
//
// The BVN is never stored in the browser: no localStorage, sessionStorage or
// cookies, and it is never logged. A revealed BVN lives in one variable and one
// DOM node for 10 seconds, then both are cleared.
'use strict';

const REVEAL_MS = 10_000;
const byId = (id) => document.getElementById(id);

let latestVault = { records: [], audit: [] };
let revealTimer = null;

function setStatus(message, isError = false) {
  const el = byId('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

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

function short(value, keep = 12) {
  return value.length > keep * 2 ? `${value.slice(0, keep)}…${value.slice(-4)}` : value;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function fill(tbodyId, rows, emptyText, columns) {
  const tbody = byId(tbodyId);
  tbody.replaceChildren();
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = cell(emptyText, 'empty');
    td.colSpan = columns;
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const row of rows) tbody.append(row);
}

function renderCustomers(customers) {
  // Newest first, using the vault's creation times (the app table has no timestamp).
  const created = new Map(latestVault.records.map((r) => [r.token, r.createdAt]));
  const sorted = [...customers].sort((a, b) => (created.get(b.bvnToken) ?? '').localeCompare(created.get(a.bvnToken) ?? ''));

  fill(
    'customers-body',
    sorted.map((c) => {
      const tr = document.createElement('tr');
      tr.append(cell(short(c.id, 8), 'mono'), cell(c.fullName), cell(c.bvnToken, 'mono token'));
      return tr;
    }),
    'No customers yet.',
    3,
  );

  const erased = new Set(latestVault.records.filter((r) => r.erasedAt).map((r) => r.token));
  fill(
    'actions-body',
    sorted.map((c) => {
      const tr = document.createElement('tr');
      const actions = document.createElement('td');
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.textContent = 'Reveal';
      reveal.addEventListener('click', () => revealBvn(c));
      const erase = document.createElement('button');
      erase.type = 'button';
      erase.textContent = erased.has(c.bvnToken) ? 'Erased' : 'Erase';
      erase.className = 'danger';
      erase.disabled = erased.has(c.bvnToken);
      erase.addEventListener('click', () => eraseBvn(c));
      actions.append(reveal, erase);
      tr.append(cell(c.fullName), cell(short(c.bvnToken), 'mono token'), actions);
      return tr;
    }),
    'No customers yet.',
    3,
  );
}

function renderVault() {
  fill(
    'vault-body',
    latestVault.records.map((r) => {
      const tr = document.createElement('tr');
      if (r.erasedAt) tr.className = 'erased';
      tr.append(
        cell(short(r.token), 'mono token'),
        cell(short(r.ciphertext, 10), 'mono'),
        r.wrappedDataKey ? cell(short(r.wrappedDataKey, 10), 'mono') : cell('destroyed', 'destroyed'),
        cell(String(r.masterKeyVersion)),
        cell(r.erasedAt ? new Date(r.erasedAt).toLocaleString() : ''),
      );
      return tr;
    }),
    'The vault holds no records for this application yet.',
    5,
  );

  const hideInspect = byId('hide-inspect').checked;
  const rows = latestVault.audit.filter((a) => !(hideInspect && a.operation === 'INSPECT'));
  fill(
    'audit-body',
    rows.map((a) => {
      const tr = document.createElement('tr');
      if (a.outcome !== 'SUCCESS') tr.className = 'refused';
      tr.append(
        cell(new Date(a.occurredAt).toLocaleTimeString()),
        cell(a.operation),
        cell(a.outcome),
        cell(a.token ? short(a.token) : '', 'mono token'),
      );
      return tr;
    }),
    'No audit rows to show.',
    4,
  );
}

async function refresh() {
  const [customers, vault] = await Promise.all([api('GET', '/customers'), api('GET', '/demo/vault')]);
  if (vault.status === 200 && vault.data) {
    latestVault = vault.data;
  } else {
    setStatus('Could not read the vault view from the middleware.', true);
  }
  renderVault();
  if (customers.status === 200 && Array.isArray(customers.data)) {
    renderCustomers(customers.data);
  } else {
    setStatus('Could not read the customer table.', true);
  }
}

function hideRevealed() {
  const el = byId('revealed');
  el.textContent = '';
  el.hidden = true;
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
}

async function revealBvn(customer) {
  hideRevealed();
  const res = await api('POST', `/customers/${customer.id}/reveal-bvn`);
  if (res.status === 200 && res.data && typeof res.data.bvn === 'string') {
    const el = byId('revealed');
    el.textContent = `${customer.fullName}: ${res.data.bvn} (synthetic; hidden again in 10 seconds)`;
    el.hidden = false;
    revealTimer = setTimeout(hideRevealed, REVEAL_MS);
    setStatus(`Revealed the BVN for ${customer.fullName}.`);
  } else if (res.status === 404) {
    setStatus(`No BVN for ${customer.fullName}: the vault says "not found" (it was erased).`, true);
  } else {
    setStatus('Reveal failed.', true);
  }
  await refresh();
}

async function eraseBvn(customer) {
  hideRevealed();
  const res = await api('POST', `/customers/${customer.id}/erase`);
  setStatus(
    res.status === 200 ? `Erased the BVN for ${customer.fullName}. Its wrapped key is destroyed.` : 'Erase failed.',
    res.status !== 200,
  );
  await refresh();
}

async function createCustomer(event) {
  event.preventDefault();
  const fullName = byId('full-name').value.trim();
  const bvnField = byId('bvn');
  if (!fullName || !/^[0-9]{11}$/.test(bvnField.value)) {
    setStatus('Enter a name and generate a synthetic BVN first.', true);
    return;
  }
  const res = await api('POST', '/customers', { fullName, bvn: bvnField.value });
  // Do not keep the BVN on the page once it has been sent.
  bvnField.value = '';
  if (res.status === 201) {
    byId('full-name').value = '';
    setStatus(`Created ${fullName}. The app stored token ${res.data.bvnToken} and no BVN.`);
  } else {
    setStatus('Create failed.', true);
  }
  await refresh();
}

document.addEventListener('DOMContentLoaded', () => {
  byId('generate').addEventListener('click', () => {
    byId('bvn').value = syntheticBvn();
  });
  byId('create-form').addEventListener('submit', createCustomer);
  byId('hide-inspect').addEventListener('change', renderVault);
  refresh();
});
