/* VoltKart storefront – vanilla JS single-page app */
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const state = {
  token: localStorage.getItem('vk_token') || null,
  user: JSON.parse(localStorage.getItem('vk_user') || 'null'),
  cart: { items: [], subtotal: 0, savings: 0, shipping: 0, total: 0 },
  meta: { categories: [], brands: [] },
  filters: { q: '', category: 'All', brand: '', sort: 'popular' },
  products: [],
};

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const off = (p) => Math.round(((p.mrp - p.price) / p.mrp) * 100);

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch('/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) logout(true);
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

/* ---------- auth ---------- */
function setSession(token, user) {
  state.token = token; state.user = user;
  localStorage.setItem('vk_token', token);
  localStorage.setItem('vk_user', JSON.stringify(user));
  paintAccount();
}
function logout(expired = false) {
  state.token = null; state.user = null;
  localStorage.removeItem('vk_token'); localStorage.removeItem('vk_user');
  state.cart = { items: [], subtotal: 0, savings: 0, shipping: 0, total: 0 };
  paintAccount(); paintCartCount(); closeDrawer();
  showHome();
  toast(expired ? 'Session expired. Log in again.' : 'Logged out');
}
function paintAccount() {
  const loggedIn = !!state.user;
  $('#accountBtn').textContent = loggedIn ? `Log out (${state.user.name.split(' ')[0]})` : 'Log in';
  $('#ordersBtn').hidden = !loggedIn;
}

/* ---------- modal ---------- */
function openModal(html, size = '') {
  const card = $('#modalCard');
  card.className = 'modal-card ' + size;
  card.innerHTML = `<button class="icon-btn modal-x" aria-label="Close" data-close>✕</button>` + html;
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  const first = card.querySelector('input, button:not(.modal-x)');
  if (first) first.focus();
}
function closeModal() {
  $('#modal').hidden = true;
  document.body.style.overflow = '';
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').hidden) closeModal(); else closeDrawer();
});

function authModal(mode = 'login', after) {
  const reg = mode === 'register';
  openModal(`
    <form class="form" id="authForm" novalidate>
      <h2>${reg ? 'Create your account' : 'Log in to VoltKart'}</h2>
      ${reg ? `<div class="field"><label for="a-name">Full name</label><input id="a-name" name="name" autocomplete="name" required></div>` : ''}
      <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="${reg ? 'At least 6 characters' : ''}" required></div>
      <div class="err" id="authErr" role="alert"></div>
      <button class="btn block" type="submit">${reg ? 'Create account' : 'Log in'}</button>
      <p class="switch">${reg ? 'Already have an account?' : 'New to VoltKart?'}
        <button type="button" id="swap">${reg ? 'Log in' : 'Create an account'}</button></p>
    </form>`, 'narrow');
  $('#swap').onclick = () => authModal(reg ? 'login' : 'register', after);
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const data = await api(reg ? '/auth/register' : '/auth/login', { method: 'POST', body: f });
      setSession(data.token, data.user);
      closeModal();
      await loadCart();
      toast(`Welcome, ${data.user.name.split(' ')[0]}!`);
      if (after) after();
    } catch (err) {
      $('#authErr').textContent = err.message;
      btn.disabled = false;
    }
  };
}

/* ---------- cart ---------- */
async function loadCart() {
  if (!state.token) return;
  try { state.cart = await api('/cart'); } catch { /* ignore */ }
  paintCartCount(); paintDrawer();
}
function paintCartCount() {
  $('#cartCount').textContent = state.cart.items.reduce((s, i) => s + i.qty, 0);
}
async function addToCart(id, qty = 1) {
  if (!state.token) return authModal('login', () => addToCart(id, qty));
  try {
    state.cart = await api('/cart', { method: 'POST', body: { productId: id, qty } });
    paintCartCount(); paintDrawer();
    toast('Added to cart');
  } catch (e) { toast(e.message, true); }
}
async function setQty(id, qty) {
  try {
    state.cart = await api('/cart/' + id, { method: 'PUT', body: { qty } });
    paintCartCount(); paintDrawer();
  } catch (e) { toast(e.message, true); }
}
function openDrawer() {
  if (!state.token) return authModal('login', openDrawer);
  paintDrawer();
  $('#scrim').hidden = false; $('#drawer').hidden = false;
}
function closeDrawer() { $('#scrim').hidden = true; $('#drawer').hidden = true; }
function paintDrawer() {
  const c = state.cart;
  const body = $('#drawerBody'), foot = $('#drawerFoot');
  if (!c.items.length) {
    body.innerHTML = `<div class="empty"><h3>Your cart is empty</h3><p>Add something you like and it will show up here.</p></div>`;
    foot.innerHTML = `<button class="btn block" id="keepShopping">Browse products</button>`;
    $('#keepShopping').onclick = () => { closeDrawer(); showHome(); };
    return;
  }
  body.innerHTML = c.items.map((i) => `
    <div class="line-item">
      <div class="line-thumb" style="--c:${esc(i.color)}22">${i.emoji}</div>
      <div>
        <b>${esc(i.name)}</b>
        <div class="qty">
          <button data-dec="${i.product_id}" aria-label="Decrease quantity">−</button>
          <span>${i.qty}</span>
          <button data-inc="${i.product_id}" aria-label="Increase quantity">+</button>
        </div>
        <div><button class="remove" data-rm="${i.product_id}">Remove</button></div>
      </div>
      <div class="line-price">${inr(i.price * i.qty)}</div>
    </div>`).join('');
  foot.innerHTML = `
    <div class="sum-row"><span>Subtotal</span><span>${inr(c.subtotal)}</span></div>
    <div class="sum-row"><span>Delivery</span><span>${c.shipping ? inr(c.shipping) : 'Free'}</span></div>
    ${c.savings ? `<div class="sum-row save"><span>You save</span><span>${inr(c.savings)}</span></div>` : ''}
    <div class="sum-row total"><span>Total</span><span>${inr(c.total)}</span></div>
    ${c.shipping ? `<p class="muted" style="font-size:13px;margin:8px 0 0">Add ${inr(999 - c.subtotal)} more for free delivery.</p>` : ''}
    <button class="btn block" id="checkoutBtn">Proceed to checkout</button>`;
  $('#checkoutBtn').onclick = checkoutModal;
}
$('#drawerBody').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const find = (id) => state.cart.items.find((i) => i.product_id === Number(id));
  if (t.dataset.inc) setQty(Number(t.dataset.inc), find(t.dataset.inc).qty + 1);
  if (t.dataset.dec) setQty(Number(t.dataset.dec), find(t.dataset.dec).qty - 1);
  if (t.dataset.rm) setQty(Number(t.dataset.rm), 0);
});
$('#scrim').onclick = closeDrawer;
$('#closeDrawer').onclick = closeDrawer;
$('#cartBtn').onclick = openDrawer;

/* ---------- checkout ---------- */
function checkoutModal() {
  const c = state.cart;
  if (!c.items.length) return;
  closeDrawer();
  openModal(`
    <form class="form" id="coForm" novalidate>
      <h2>Delivery & payment</h2>
      <div class="two">
        <div class="field"><label for="c-name">Full name</label><input id="c-name" name="name" autocomplete="name" value="${esc(state.user.name)}" required></div>
        <div class="field"><label for="c-phone">Mobile number</label><input id="c-phone" name="phone" inputmode="numeric" maxlength="10" autocomplete="tel-national" placeholder="10 digits" required></div>
      </div>
      <div class="field"><label for="c-addr">Address</label><textarea id="c-addr" name="address" rows="2" autocomplete="street-address" placeholder="House no, street, area" required></textarea></div>
      <div class="two">
        <div class="field"><label for="c-city">City</label><input id="c-city" name="city" autocomplete="address-level2" required></div>
        <div class="field"><label for="c-pin">Pincode</label><input id="c-pin" name="pincode" inputmode="numeric" maxlength="6" autocomplete="postal-code" required></div>
      </div>
      <fieldset style="border:0;padding:0;margin:0">
        <legend style="font-size:14px;font-weight:600;margin-bottom:6px">Payment method</legend>
        <div class="pay">
          <label><input type="radio" name="paymentMethod" value="COD" checked><span>Cash on delivery</span></label>
          <label><input type="radio" name="paymentMethod" value="UPI"><span>UPI</span></label>
          <label><input type="radio" name="paymentMethod" value="CARD"><span>Card</span></label>
        </div>
        <p class="muted" style="font-size:13px;margin:6px 0 0">Demo store: UPI and card are simulated, you won't be charged.</p>
      </fieldset>
      <div class="order-sum">
        <div class="sum-row"><span>${c.items.reduce((s, i) => s + i.qty, 0)} item(s)</span><span>${inr(c.subtotal)}</span></div>
        <div class="sum-row"><span>Delivery</span><span>${c.shipping ? inr(c.shipping) : 'Free'}</span></div>
        <div class="sum-row total"><span>Pay</span><span>${inr(c.total)}</span></div>
      </div>
      <div class="err" id="coErr" role="alert"></div>
      <button class="btn block" type="submit">Place order · ${inr(c.total)}</button>
    </form>`, 'mid');
  $('#coForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(e.target));
      const r = await api('/orders', { method: 'POST', body });
      state.cart = { items: [], subtotal: 0, savings: 0, shipping: 0, total: 0 };
      paintCartCount(); paintDrawer();
      $('#modalCard').innerHTML = `
        <button class="icon-btn modal-x" aria-label="Close" data-close>✕</button>
        <div class="success">
          <div class="tick" aria-hidden="true">✓</div>
          <h2>Order placed</h2>
          <p>Order <b>#${r.orderId}</b> for <b>${inr(r.total)}</b> is confirmed.</p>
          <p class="muted">You can track it under My orders.</p>
          <div style="display:flex;gap:10px;margin-top:8px">
            <button class="btn" id="goOrders">View my orders</button>
            <button class="btn ghost" data-close>Keep shopping</button>
          </div>
        </div>`;
      $('#goOrders').onclick = () => { closeModal(); showOrders(); };
      loadProducts();
    } catch (err) {
      $('#coErr').textContent = err.message;
      btn.disabled = false;
    }
  };
}

/* ---------- product detail ---------- */
async function productModal(id) {
  try {
    const { product: p, related } = await api('/products/' + id);
    const stock = p.stock === 0 ? `<span class="stock-out">Out of stock</span>`
      : p.stock <= 15 ? `<span class="stock-low">Only ${p.stock} left</span>`
      : `<span class="stock-ok">In stock</span>`;
    openModal(`
      <div class="detail">
        <div class="detail-art" style="--c:${esc(p.color)}26"><span class="emoji" aria-hidden="true">${p.emoji}</span></div>
        <div class="detail-info">
          <span class="p-brand">${esc(p.brand)} · ${esc(p.category)}</span>
          <h2>${esc(p.name)}</h2>
          <div class="rating"><span class="stars">★ ${p.rating.toFixed(1)}</span> (${p.reviews.toLocaleString('en-IN')} ratings)</div>
          <div class="price-row"><span class="price">${inr(p.price)}</span><span class="mrp">${inr(p.mrp)}</span><span class="pct" style="position:static">${off(p)}% off</span></div>
          <p style="margin:4px 0">${esc(p.description)}</p>
          <ul class="specs">${p.specs.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
          <div>${stock}</div>
          <button class="btn" id="detailAdd" ${p.stock === 0 ? 'disabled' : ''}>Add to cart</button>
        </div>
      </div>
      ${related.length ? `<div class="related"><h3>More in ${esc(p.category)}</h3><div class="related-row">
        ${related.map((r) => `<button class="mini" data-open="${r.id}"><span class="e">${r.emoji}</span><b>${esc(r.name)}</b><span class="muted">${inr(r.price)}</span></button>`).join('')}
      </div></div>` : ''}`);
    $('#detailAdd').onclick = () => addToCart(p.id);
    $('#modalCard').querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => productModal(b.dataset.open)));
  } catch (e) { toast(e.message, true); }
}

/* ---------- home / catalogue ---------- */
function productCard(p) {
  return `
  <article class="product">
    <button class="thumb" style="--c:${esc(p.color)}26" data-open="${p.id}" aria-label="View ${esc(p.name)}">
      <span class="emoji" aria-hidden="true">${p.emoji}</span>
      <span class="pct">${off(p)}% off</span>
      ${p.stock > 0 && p.stock <= 15 ? `<span class="low">Only ${p.stock} left</span>` : ''}
    </button>
    <div class="p-body">
      <span class="p-brand">${esc(p.brand)}</span>
      <button class="p-name" data-open="${p.id}">${esc(p.name)}</button>
      <div class="rating"><span class="stars">★ ${p.rating.toFixed(1)}</span> (${p.reviews.toLocaleString('en-IN')})</div>
      <div class="price-row"><span class="price">${inr(p.price)}</span><span class="mrp">${inr(p.mrp)}</span></div>
      <button class="btn" data-add="${p.id}" ${p.stock === 0 ? 'disabled' : ''}>${p.stock === 0 ? 'Out of stock' : 'Add to cart'}</button>
    </div>
  </article>`;
}

async function loadProducts() {
  const f = state.filters;
  const qs = new URLSearchParams();
  if (f.q) qs.set('q', f.q);
  if (f.category !== 'All') qs.set('category', f.category);
  if (f.brand) qs.set('brand', f.brand);
  qs.set('sort', f.sort);
  try {
    const { products } = await api('/products?' + qs);
    state.products = products;
    paintGrid();
  } catch (e) { toast(e.message, true); }
}

function paintGrid() {
  const grid = $('#grid'); if (!grid) return;
  const f = state.filters;
  $('#resultTitle').textContent = f.q ? `Results for "${f.q}"` : f.category === 'All' ? 'All products' : f.category;
  $('#resultCount').textContent = `${state.products.length} item${state.products.length === 1 ? '' : 's'}`;
  grid.innerHTML = state.products.length
    ? state.products.map(productCard).join('')
    : `<div class="empty" style="grid-column:1/-1"><h3>No products match</h3><p>Try a different word, or clear the brand filter.</p></div>`;
}

function paintChips() {
  const total = state.meta.categories.reduce((s, c) => s + c.count, 0);
  const all = [{ name: 'All', count: total }, ...state.meta.categories];
  $('#chips').innerHTML = all.map((c) =>
    `<button class="chip ${state.filters.category === c.name ? 'on' : ''}" data-cat="${esc(c.name)}">${esc(c.name)}<small>${c.count}</small></button>`).join('');
}

function showHome(scrollToCatalogue = false) {
  view.innerHTML = `
    <section class="hero">
      <div class="wrap hero-inner">
        <div>
          <h1>Real gadgets. Real discounts. Home in days.</h1>
          <p>Phones, laptops, audio and smart-home gear from brands we stock ourselves, with a 7-day replacement on everything.</p>
          <div class="hero-cta">
            <a class="btn tag" href="#catalogue" id="shopNow">Shop all products</a>
            <button class="btn ghost" id="heroAudio">Browse audio</button>
          </div>
        </div>
        <div class="hero-stack" id="heroStack"></div>
      </div>
    </section>
    <div class="perks"><div class="wrap">
      <span><b>Free delivery</b> above ₹999</span>
      <span><b>7-day</b> replacement</span>
      <span><b>Brand warranty</b> on every item</span>
      <span><b>Cash on delivery</b> available</span>
    </div></div>
    <section class="wrap catalogue" id="catalogue">
      <div class="cat-row" id="chips" role="group" aria-label="Categories"></div>
      <div class="toolbar">
        <h2 id="resultTitle">All products</h2>
        <span class="muted" id="resultCount"></span>
        <label>Brand
          <select id="brandSel"><option value="">All brands</option>${state.meta.brands.map((b) => `<option ${state.filters.brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
        </label>
        <label>Sort by
          <select id="sortSel">
            ${[['popular', 'Most popular'], ['price-asc', 'Price: low to high'], ['price-desc', 'Price: high to low'], ['rating', 'Top rated'], ['discount', 'Biggest discount']]
              .map(([v, l]) => `<option value="${v}" ${state.filters.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="grid" id="grid"></div>
    </section>`;

  paintChips();
  $('#searchInput').value = state.filters.q;
  $('#chips').onclick = (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    state.filters.category = b.dataset.cat; state.filters.q = ''; $('#searchInput').value = '';
    paintChips(); loadProducts();
  };
  $('#brandSel').onchange = (e) => { state.filters.brand = e.target.value; loadProducts(); };
  $('#sortSel').onchange = (e) => { state.filters.sort = e.target.value; loadProducts(); };
  $('#grid').onclick = (e) => {
    const open = e.target.closest('[data-open]'); if (open) return productModal(open.dataset.open);
    const add = e.target.closest('[data-add]'); if (add) addToCart(Number(add.dataset.add));
  };
  $('#heroAudio').onclick = () => {
    state.filters.category = 'Audio'; paintChips(); loadProducts();
    $('#catalogue').scrollIntoView({ behavior: 'smooth' });
  };

  // hero tiles: the three biggest discounts
  api('/products?sort=discount').then(({ products }) => {
    const stack = $('#heroStack'); if (!stack) return;
    stack.innerHTML = products.slice(0, 4).map((p) => `
      <button class="hero-tile" data-open="${p.id}">
        <span class="big" aria-hidden="true">${p.emoji}</span>
        <b>${esc(p.name)}</b>
        <span>${inr(p.price)}</span>
        <span class="off">${off(p)}% off</span>
      </button>`).join('');
    stack.onclick = (e) => { const t = e.target.closest('[data-open]'); if (t) productModal(t.dataset.open); };
  }).catch(() => {});

  loadProducts();
  if (scrollToCatalogue) $('#catalogue').scrollIntoView();
  else window.scrollTo(0, 0);
}

/* ---------- orders page ---------- */
async function showOrders() {
  if (!state.token) return authModal('login', showOrders);
  view.innerHTML = `<section class="wrap page"><h1>My orders</h1><div id="orderList" class="muted">Loading…</div></section>`;
  window.scrollTo(0, 0);
  try {
    const { orders } = await api('/orders');
    $('#orderList').outerHTML = orders.length ? `<div id="orderList">${orders.map((o) => `
      <article class="order">
        <div class="order-head">
          <div>Order <b>#${o.id}</b></div>
          <div>Placed on<b>${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</b></div>
          <div>Total<b>${inr(o.total)}</b></div>
          <div>Status<b><span class="status">${esc(o.status)}</span></b></div>
        </div>
        <div class="order-body">
          <ul>${o.items.map((i) => `<li><span>${esc(i.name)} × ${i.qty}</span><span>${inr(i.price * i.qty)}</span></li>`).join('')}</ul>
          <p class="muted" style="margin:10px 0 0;font-size:14px">Delivering to ${esc(o.ship_name)}, ${esc(o.ship_address)}, ${esc(o.ship_city)} – ${esc(o.ship_pincode)} · Paid via ${esc(o.payment_method)}</p>
        </div>
      </article>`).join('')}</div>`
      : `<div class="empty"><h3>No orders yet</h3><p>Your orders will show up here once you place one.</p><button class="btn" id="startShop">Start shopping</button></div>`;
    const s = $('#startShop'); if (s) s.onclick = () => showHome();
  } catch (e) { $('#orderList').textContent = e.message; }
}

/* ---------- wiring ---------- */
$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  state.filters.q = $('#searchInput').value.trim();
  state.filters.category = 'All';
  if (!$('#grid')) showHome(true);
  else { paintChips(); loadProducts(); $('#catalogue').scrollIntoView({ behavior: 'smooth' }); }
};
$('#accountBtn').onclick = () => (state.user ? logout() : authModal('login'));
$('#ordersBtn').onclick = showOrders;
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav="home"]');
  if (nav) { e.preventDefault(); state.filters = { q: '', category: 'All', brand: '', sort: 'popular' }; showHome(); }
});

(async function init() {
  paintAccount();
  try { state.meta = await api('/products/meta'); } catch { /* shows empty chips */ }
  showHome();
  if (state.token) {
    try { await api('/auth/me'); await loadCart(); } catch { /* logout handled in api() */ }
  }
})();
