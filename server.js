const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const QB_CLIENT_ID     = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const QB_REDIRECT_URI  = process.env.QB_REDIRECT_URI;
const QB_ENV           = process.env.QB_ENVIRONMENT || 'sandbox';
const QB_BASE_URL      = QB_ENV === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
const QB_TOKEN_URL     = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_AUTH_URL      = 'https://appcenter.intuit.com/connect/oauth2';
const ADMIN_KEY        = process.env.ADMIN_KEY || 'NTXnetboxshop2026';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let tokenStore = { accessToken: process.env.QB_ACCESS_TOKEN || null, refreshToken: process.env.QB_REFRESH_TOKEN || null, realmId: process.env.QB_REALM_ID || null };

// ── QB Auth ───────────────────────────────────────────────
app.get('/qb/connect', (req, res) => {
  const p = new URLSearchParams({ client_id: QB_CLIENT_ID, scope: 'com.intuit.quickbooks.accounting com.intuit.quickbooks.payment', redirect_uri: QB_REDIRECT_URI, response_type: 'code', state: 'nb' });
  res.redirect(`${QB_AUTH_URL}?${p}`);
});

app.get('/qb/callback', async (req, res) => {
  const { code, realmId } = req.query;
  try {
    const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
    const r = await axios.post(QB_TOKEN_URL, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: QB_REDIRECT_URI }), { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
    tokenStore = { accessToken: r.data.access_token, refreshToken: r.data.refresh_token, realmId };
    await supabase.from('settings').upsert({ key: 'qb_tokens', value: JSON.stringify(tokenStore) });
    res.send('<html><body style="font-family:system-ui;max-width:500px;margin:60px auto;text-align:center"><h2 style="color:#2563EB">✅ QuickBooks conectado exitosamente</h2><p>Las facturas se crearán automáticamente.</p><a href="/" style="background:#2563EB;color:#fff;padding:12px 24px;border-radius:24px;text-decoration:none;font-weight:700">Ir a la plataforma →</a></body></html>');
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

async function refreshToken() {
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(QB_TOKEN_URL, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenStore.refreshToken }), { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
  tokenStore.accessToken = r.data.access_token;
  tokenStore.refreshToken = r.data.refresh_token;
  await supabase.from('settings').upsert({ key: 'qb_tokens', value: JSON.stringify(tokenStore) });
}

async function qb(method, endpoint, data) {
  try {
    const r = await axios({ method, url: `${QB_BASE_URL}/v3/company/${tokenStore.realmId}${endpoint}`, data, headers: { Authorization: `Bearer ${tokenStore.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
    return r.data;
  } catch (e) {
    if (e.response?.status === 401) { await refreshToken(); return qb(method, endpoint, data); }
    throw e;
  }
}

async function createQBInvoice(order) {
  const c = order.client;
  const search = await qb('GET', `/query?query=${encodeURIComponent("SELECT * FROM Customer WHERE PrimaryEmailAddr = '" + c.mail + "'")}&minorversion=65`);
  let customer = search?.QueryResponse?.Customer?.[0];
  if (!customer) {
    const cr = await qb('POST', '/customer?minorversion=65', { DisplayName: c.nombre + ' (' + c.cedula + ')', PrimaryEmailAddr: { Address: c.mail }, PrimaryPhone: { FreeFormNumber: c.tel }, BillAddr: { Line1: '1942 NE 148 Street, Suite ' + c.suite, City: 'North Miami', CountrySubDivisionCode: 'FL', PostalCode: '33181', Country: 'USA' } });
    customer = cr.Customer;
  }
  const lines = order.products.map((p, i) => ({ Id: String(i+1), LineNum: i+1, Description: p.nombre + (p.url ? '\n' + p.url : ''), Amount: (parseFloat(p.precio)||0)*(parseInt(p.qty)||1), DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: parseInt(p.qty)||1, UnitPrice: parseFloat(p.precio)||0 } }));
  lines.push({ Id: String(order.products.length+1), LineNum: order.products.length+1, Description: 'Sales Tax Florida (7%)', Amount: order.salesTax || 0, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1, UnitPrice: order.salesTax || 0 } });
  lines.push({ Id: String(order.products.length+2), LineNum: order.products.length+2, Description: 'Recargo de servicio Netbox Corp (5%)', Amount: order.recargo, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1, UnitPrice: order.recargo } });
  const inv = await qb('POST', '/invoice?minorversion=65&include=invoiceLink', { CustomerRef: { value: customer.Id }, BillEmail: { Address: c.mail }, EmailStatus: 'NeedToSend', Line: lines, CustomerMemo: { value: 'Pedido ' + order.id + ' — Suite ' + c.suite }, PrivateNote: 'Cedula: ' + c.cedula });
  return inv.Invoice;
}

// ── AUTO FETCH PRODUCT NAME ───────────────────────────────
app.get('/api/product-name', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 8000,
      maxRedirects: 5
    });
    const html = response.data;
    // Try og:title, then twitter:title, then <title>
    const og = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
             || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    const tw = html.match(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i);
    const ti = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const raw = (og && og[1]) || (tw && tw[1]) || (ti && ti[1]) || '';
    // Clean up — remove site name suffix
    const name = raw.replace(/\s*[\|\-–—·•]\s*.{0,40}$/, '').replace(/&amp;/g,'&').replace(/&#39;/g,"'").trim();
    res.json({ name: name || null });
  } catch (e) {
    res.json({ name: null, error: e.message });
  }
});

// ── CREATE ORDER ──────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  const order = req.body;
  try {
    await supabase.from('orders').insert({ id: order.id, status: 'processing', client: order.client, products: order.products, subtotal: order.subtotal, recargo: order.recargo, total: order.total, created_at: new Date().toISOString(), qb_link: null, last_four: null, invoice_id: null, admin_notes: null });
    let paymentLink = null, invoiceId = null;
    if (tokenStore.accessToken && tokenStore.realmId) {
      try {
        const inv = await createQBInvoice(order);
        invoiceId = inv.Id;
        paymentLink = inv.InvoiceLink || null;
        await supabase.from('orders').update({ invoice_id: invoiceId, qb_link: paymentLink, status: paymentLink ? 'invoice_sent' : 'processing' }).eq('id', order.id);
      } catch (e) { console.error('QB error:', e.message); }
    }
    res.json({ success: true, orderId: order.id, invoiceId, paymentLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET ORDERS BY CLIENT ──────────────────────────────────
app.get('/api/orders/client', async (req, res) => {
  const { mail, suite } = req.query;
  if (!mail || !suite) return res.status(400).json({ error: 'mail y suite requeridos' });
  try {
    const { data } = await supabase.from('orders').select('*').ilike('client->>mail', mail).ilike('client->>suite', suite).order('created_at', { ascending: false });
    res.json({ orders: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET ALL ORDERS (ADMIN) ────────────────────────────────
app.get('/api/orders', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'No autorizado' });
  try {
    const { data } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
    res.json({ orders: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UPDATE ORDER (ADMIN) ──────────────────────────────────
app.patch('/api/orders/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'No autorizado' });
  const patch = {};
  if (req.body.status)      patch.status      = req.body.status;
  if (req.body.qbLink)      patch.qb_link     = req.body.qbLink;
  if (req.body.lastFour)    patch.last_four   = req.body.lastFour;
  if (req.body.adminNotes)  patch.admin_notes = req.body.adminNotes;
  try {
    await supabase.from('orders').update(patch).eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── QB WEBHOOK ────────────────────────────────────────────
app.post('/qb/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());
    for (const notif of (payload?.eventNotifications || [])) {
      for (const entity of (notif?.dataChangeEvent?.entities || [])) {
        if (entity.name === 'Payment') {
          const payment = await qb('GET', `/payment/${entity.id}?minorversion=65`);
          const lastFour = payment?.Payment?.CreditCardInfo?.Number?.slice(-4) || null;
          const invoiceRef = payment?.Payment?.Line?.[0]?.LinkedTxn?.[0]?.TxnId;
          if (invoiceRef) {
            await supabase.from('orders').update({ status: 'purchased', last_four: lastFour }).eq('invoice_id', invoiceRef);
          }
        }
      }
    }
  } catch (e) { console.error('Webhook error:', e.message); }
  res.status(200).json({ received: true });
});

// ── STATUS ────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({ qbConnected: !!(tokenStore.accessToken && tokenStore.realmId), environment: QB_ENV }));

// ── START ─────────────────────────────────────────────────
async function start() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'qb_tokens').single();
    if (data?.value) { tokenStore = { ...tokenStore, ...JSON.parse(data.value) }; console.log('QB tokens loaded'); }
  } catch (e) {}
  app.listen(process.env.PORT || 3000, () => console.log('Server running on port', process.env.PORT || 3000));
}
start();
