const $ = (s) => document.querySelector(s);
const form = $('#analyzeForm');
const fileInput = $('#fileInput');
const dropZone = $('#dropZone');
const fileChip = $('#fileChip');
const resultPanel = $('#resultPanel');
const loadingPanel = $('#loadingPanel');

const money = (n, currency = 'IDR') => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  try { return new Intl.NumberFormat('id-ID', { style:'currency', currency, maximumFractionDigits: currency === 'IDR' ? 0 : 2 }).format(Number(n)); }
  catch { return `${currency} ${Number(n).toLocaleString('id-ID')}`; }
};
const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const marketName = v => ({indonesia:'Indonesia', sea:'Asia Tenggara', international:'International'})[v] || v;
const modeName = v => ({market:'Harga Pasar', cheapest:'Termurah Comparable', best_match:'Paling Sesuai'})[v] || v;

async function api(url, options={}) {
  const r = await fetch(url, options);
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401) { location.href = '/login'; throw new Error('Sesi berakhir.'); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

dropZone.addEventListener('click', (e) => { if (!e.target.closest('.file-chip')) fileInput.click(); });
['dragenter','dragover'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave','drop'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', e => { if (e.dataTransfer.files?.[0]) { fileInput.files = e.dataTransfer.files; showFile(); } });
fileInput.addEventListener('change', showFile);
function showFile() {
  const f = fileInput.files?.[0];
  if (!f) { fileChip.hidden = true; return; }
  fileChip.hidden = false;
  fileChip.innerHTML = `<span>${esc(f.name)}</span><button type="button" aria-label="hapus">×</button>`;
  fileChip.querySelector('button').onclick = e => { e.stopPropagation(); fileInput.value=''; fileChip.hidden=true; };
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(form);
  if (fileInput.files?.[0]) fd.set('file', fileInput.files[0]);
  const text = String(fd.get('text') || '').trim();
  if (!text && !fileInput.files?.[0]) return alert('Masukkan deskripsi atau upload file terlebih dahulu.');

  resultPanel.hidden = true; loadingPanel.hidden = false;
  const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
  const loadingTexts = ['Membaca dokumen dan mengekstrak spesifikasi…','Mencari pembanding aktual di pasar…','Memeriksa kecocokan spesifikasi dan harga…','Menghitung statistik benchmark…'];
  let i=0; $('#loadingCopy').textContent = loadingTexts[0];
  const timer = setInterval(() => $('#loadingCopy').textContent = loadingTexts[++i % loadingTexts.length], 3500);
  try {
    const data = await api('/api/analyze', { method:'POST', body:fd });
    renderResult(data); await loadHistory();
    resultPanel.scrollIntoView({ behavior:'smooth', block:'start' });
  } catch(err) { alert(err.message); }
  finally { clearInterval(timer); loadingPanel.hidden = true; btn.disabled = false; }
});

function renderResult(d) {
  resultPanel.hidden = false;
  $('#resultTitle').textContent = d.extracted?.title || 'Analisis harga';
  $('#resultSummary').textContent = `${marketName(d.market)} · ${modeName(d.mode)} · ${d.extracted?.summary || ''}`;
  $('#resultKind').textContent = (d.extracted?.kind || 'unknown').toUpperCase();
  const s = d.stats || {};
  const proposal = d.extracted?.proposal_price;
  const proposalCur = d.extracted?.proposal_currency || s.currency || 'IDR';
  const diff = proposal && s.median && proposalCur === s.currency ? ((proposal - s.median) / s.median) * 100 : null;
  const metrics = [
    ['Proposal', money(proposal, proposalCur), proposal ? 'Harga input/proposal' : 'Tidak terdeteksi'],
    ['Termurah', money(s.lowest, s.currency), s.count ? `${s.count} comparable terhitung` : 'Belum cukup data'],
    ['Median Pasar', money(s.median, s.currency), 'Benchmark utama'],
    ['P75', money(s.p75, s.currency), diff == null ? 'Kuartil atas' : `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}% proposal vs median`]
  ];
  $('#metricGrid').innerHTML = metrics.map(([k,v,n]) => `<div class="metric"><span>${esc(k)}</span><strong>${esc(v)}</strong><small>${esc(n)}</small></div>`).join('');

  const rows = d.comparables || [];
  $('#compareCount').textContent = `${rows.length} hasil`;
  $('#compareBody').innerHTML = rows.length ? rows.map((r,idx) => `<tr>
    <td>${idx+1}</td><td><strong>${esc(r.name)}</strong><small>${esc(r.vendor)}</small></td>
    <td class="price-cell">${esc(money(r.price,r.currency))}<small>${esc(r.unit || '')}</small></td>
    <td><span class="match ${r.match_score>=85?'good':r.match_score>=70?'mid':'low'}">${Math.round(r.match_score)}%</span></td>
    <td><span>${esc(r.match_notes)}</span><small>${esc(r.price_notes)}</small></td>
    <td>${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener noreferrer">Buka ↗</a>` : '<span class="muted">URL tidak tervalidasi</span>'}</td>
  </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state">Belum ada harga comparable yang berhasil dinormalisasi.</div></td></tr>`;
  $('#analysisText').textContent = d.analysis || '—';
  $('#caveatList').innerHTML = (d.caveats?.length ? d.caveats : ['Verifikasi kembali harga dan scope langsung ke vendor sebelum keputusan procurement.']).map(x=>`<li>${esc(x)}</li>`).join('');
  $('#sourceList').innerHTML = (d.sources?.length ? d.sources : []).map((s,i)=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><b>${i+1}</b><span>${esc(s.title || s.url)}</span><em>↗</em></a>`).join('') || '<div class="empty-state">Sumber URL tidak terdeteksi pada response grounding.</div>';
}

async function loadHistory() {
  try {
    const rows = await api('/api/history');
    const box = $('#historyList');
    if (!rows.length) return box.innerHTML = '<div class="empty-state">Belum ada analisis.</div>';
    box.innerHTML = rows.slice(0,40).map(r => `<button class="history-item" data-id="${esc(r.id)}">
      <span><strong>${esc(r.extracted?.title || r.id)}</strong><small>${new Date(r.createdAt).toLocaleString('id-ID')} · ${esc(marketName(r.market))}</small></span><em>›</em>
    </button>`).join('');
    [...box.querySelectorAll('.history-item')].forEach((el,idx)=> el.onclick = () => { renderResult(rows[idx]); resultPanel.scrollIntoView({behavior:'smooth'}); });
  } catch(e) { console.error(e); }
}

$('#refreshHistory').onclick = loadHistory;
$('#logoutBtn').onclick = async () => { try { await api('/api/logout',{method:'POST'}); } finally { location.href='/login'; } };
loadHistory();
