// Research dashboard: controls, session calculations, tables, and charts.
const $=s=>document.querySelector(s),D=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const st={inst:'xau',rows:[],dow:new Set([0,1,2,3,4,5,6]),meta:null,res:null};
const root=document.documentElement,fmt=(n,d=0)=>n.toLocaleString('en-US',{maximumFractionDigits:d,minimumFractionDigits:d});
try{if(localStorage.getItem('th')==='dark')root.dataset.theme='dark'}catch(e){}
$('th').onclick=()=>{root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('th',root.dataset.theme)}catch(e){}draw()};
const col=n=>getComputedStyle(root).getPropertyValue(n).trim();

// Filter controls and request the matching session sample.
function chips(){$('#dow').innerHTML='<span class="note days-label">Days:</span>'+[1,2,3,4,5,6,0].map(d=>`<button data-d="${d}" class="${st.dow.has(d)?'on':''}">${D[d]}</button>`).join('')}
$('#dow').onclick=e=>{let d=e.target.dataset.d;if(d==null)return;d=+d;st.dow.has(d)?st.dow.delete(d):st.dow.add(d);chips();load()};
$('#inst').onclick=e=>{if(!e.target.dataset.i)return;st.inst=e.target.dataset.i;[...$('#inst').children].forEach(b=>b.classList.toggle('on',b===e.target));load()};
let tm;function load(){clearTimeout(tm);tm=setTimeout(async()=>{
  const q=new URLSearchParams({inst:st.inst,from:$('#f').value,to:$('#t').value,tz:$('#tz').value,years:$('#yr').value,dow:[...st.dow].join(',')});
  const r=await fetch('/api/research/sessions?'+q);if(r.status===401)return location='/login';st.res=await r.json();st.rows=st.res.rows;calc()},200)}
['f','t','tz','yr'].forEach(i=>$('#'+i).onchange=load);['thr','md','lots','cs','bal'].forEach(i=>$('#'+i).oninput=calc);

// Summarize direction outcomes and position risk for the selected sessions.
const pct=(a,p)=>a.length?a[Math.min(a.length-1,Math.floor(p*a.length))]:0;
const cnt=(a,x)=>{let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;a[m]<x?lo=m+1:hi=m}return a.length-lo};
let S={};
function calc(){
  const thr=+$('#thr').value||0,touch=$('#md').value==='touch',rows=st.rows,n=rows.length;
  const up=rows.map(r=>touch?r[2]:Math.max(0,r[4])),dn=rows.map(r=>touch?r[3]:Math.max(0,-r[4]));
  const cls=rows.map((r,i)=>{const u=up[i]>=thr,d=dn[i]>=thr;return u&&d?'b':u?'u':d?'d':'n'});
  const c={u:0,d:0,b:0,n:0};cls.forEach(x=>c[x]++);const hit=c.u+c.d+c.b;
  const asc=a=>a.slice().sort((x,y)=>x-y),rg=up.map((u,i)=>Math.max(u,dn[i]));
  S={n,up,dn,cls,c,thr,touch,U:asc(up),Dn:asc(dn),R:asc(rg),rows};
  const f=$('#f').value,t=$('#t').value,tz=+$('#tz').value,z=tz===3?'EAT':'UTC'+(tz>=0?'+':'')+tz,nm=st.inst==='xau'?'XAUUSD':'COMEX gold';
  $('#say').innerHTML=n?`Across <b>${n}</b> sessions, ${nm} moved $${thr} or more from its ${f} ${z} price ${touch?'at some point before':'by'} ${t} on <b>${hit}</b> of them (<b>${fmt(hit/n*100,1)}%</b>): ${c.u} up, ${c.d} down, ${c.b} both.`:'No complete sessions for this window. Load history first (see Data below).';
  const r=st.res||{};$('#snap').textContent=n?`${r.skipped||0} sessions skipped for missing bars (weekends, holidays, gaps). Bars are ${r.step} min, so the window is ${fmt(r.from/60,2)}h–${fmt(r.to/60,2)}h local.`:'';
  const k=(v,l)=>`<div><div class="v">${v}</div><div class="k">${l}</div></div>`;
  $('#kpi').innerHTML=n?k(n,'sessions')+k(fmt(hit/n*100,1)+'%','reached distance')+k(fmt(c.u+c.b),'reached up')+k(fmt(c.d+c.b),'reached down')+k('$'+fmt(pct(S.R,.5),2),'median largest move')+k('$'+fmt(pct(S.R,.9),2),'90th percentile'):'';
  risk();groups();draw()}
function risk(){const{n,U,Dn,R}=S;if(!n){$('#rk').innerHTML='';return}
  const oz=(+$('#lots').value||0)*(+$('#cs').value||0),bal=+$('#bal').value||1;
  const row=(l,a,p)=>{const v=pct(a,p);return `<tr><td>${l}</td><td>$${fmt(v,2)}</td><td>$${fmt(v*oz)}</td><td>${fmt(v*oz/bal*100,1)}%</td></tr>`};
  const hd='<tr><th>Worst share of sessions</th><th>Move</th><th>Loss</th><th>% of balance</th></tr>';
  const blk=(t,a)=>`<tr><th class="table-section" colspan="4">${t}</th></tr>`+[[.75,'Worst 25%'],[.9,'Worst 10%'],[.95,'Worst 5%'],[.99,'Worst 1%']].map(([p,l])=>row(l,a,p)).join('');
  $('#rk').innerHTML=hd+blk('Long position: down move',Dn)+blk('Short position: up move',U)+blk('Either direction: largest move',R)}
function groups(){const{n,rows,thr,up,dn}=S,tz=+$('#tz').value,Y={},W={};
  rows.forEach((r,i)=>{const d=new Date(r[0]+tz*36e5),h=up[i]>=thr||dn[i]>=thr;for(const[o,k]of[[Y,d.getUTCFullYear()],[W,d.getUTCDay()]]){const x=o[k]||(o[k]=[0,0]);x[1]++;if(h)x[0]++}});
  const b=(o,l)=>Object.keys(o).sort().map(k=>`<div class="bar"><span class="mono">${l(k)}</span><span><i style="width:${o[k][0]/o[k][1]*100}%"></i></span><span class="mono bar-count">${o[k][0]}/${o[k][1]}</span></div>`).join('');
  $('#by').innerHTML=n?b(Y,k=>k):'';$('#bw').innerHTML=n?b(W,k=>D[k]):''}

// Draw day-by-day outcomes and probability curves on responsive canvases.
function fit(c,h){const r=Math.min(devicePixelRatio||1,1.5),w=c.clientWidth;c.width=w*r;c.height=h*r;c.style.height=h+'px';const x=c.getContext('2d');x.setTransform(r,0,0,r,0,0);return[x,w]}
function draw(){if(!S.n&&S.n!==0)return;dm();cv()}
function dm(){const c=$('#dm'),rows=S.rows,tz=+$('#tz').value;if(!S.n){fit(c,40);return}
  const ys=[...new Set(rows.map(r=>new Date(r[0]+tz*36e5).getUTCFullYear()))].sort(),rh=22,[x,w]=fit(c,ys.length*rh+8),L=44,W=w-L-8,col2={u:col('--up'),d:col('--dn'),b:col('--gold'),n:col('--faint')};
  x.font='11px IBM Plex Mono';x.fillStyle=col('--mute');ys.forEach((y,i)=>x.fillText(y,0,i*rh+rh/2+4));
  const rad=Math.max(1.1,Math.min(2.6,W/366*.42));
  ['n','u','d','b'].forEach(k=>{x.fillStyle=col2[k];x.beginPath();rows.forEach((r,i)=>{if(S.cls[i]!==k)return;const d=new Date(r[0]+tz*36e5),y=ys.indexOf(d.getUTCFullYear()),doy=(d-Date.UTC(d.getUTCFullYear(),0,1))/864e5,px=L+doy/366*W,py=y*rh+rh/2;x.moveTo(px+rad,py);x.arc(px,py,rad,0,6.283)});x.fill()})}
function cv(){const c=$('#cv'),[x,w]=fit(c,300),h=300,pl=44,pb=26,pt=10,pr=10;if(!S.n)return;
  const mx=Math.max(60,S.thr*2,Math.ceil(S.R[Math.floor(S.n*.99)]||0)),X=v=>pl+v/mx*(w-pl-pr),Y=p=>pt+(1-p)*(h-pt-pb),P=(a,v)=>cnt(a,v)/S.n;
  x.font='11px IBM Plex Mono';x.fillStyle=col('--mute');x.strokeStyle=col('--line');x.lineWidth=1;
  for(let p=0;p<=1.001;p+=.25){x.beginPath();x.moveTo(pl,Y(p));x.lineTo(w-pr,Y(p));x.stroke();x.fillText(Math.round(p*100)+'%',4,Y(p)+4)}
  const st2=Math.ceil(mx/6/10)*10;for(let v=0;v<=mx;v+=st2)x.fillText('$'+v,X(v)-10,h-8);
  [[S.Dn,'--dn'],[S.U,'--up'],[S.R,'--gold']].forEach(([a,cn])=>{x.strokeStyle=col(cn);x.lineWidth=2;x.beginPath();for(let v=0;v<=mx;v+=mx/160){const px=X(v),py=Y(P(a,v));v?x.lineTo(px,py):x.moveTo(px,py)}x.stroke()});
  x.strokeStyle=col('--ink');x.setLineDash([2,4]);x.beginPath();x.moveTo(X(S.thr),pt);x.lineTo(X(S.thr),h-pb);x.stroke();x.setLineDash([]);
  const e=P(S.R,S.thr);x.fillStyle=col('--gold');x.beginPath();x.arc(X(S.thr),Y(e),4,0,6.283);x.fill();x.fillStyle=col('--ink');x.fillText(fmt(e*100,1)+'% at $'+S.thr,Math.min(X(S.thr)+8,w-110),Y(e)-8)}

// Load source metadata and refresh controls.
async function meta(){const m=await (await fetch('/api/research/meta')).json();st.meta=m;
  $('#meta').innerHTML=Object.values(m.inst).map(i=>`<div><b>${i.name}</b>: ${i.bars?`${fmt(i.bars)} bars of ${i.stepMin} min, ${i.spanYears} years, ${new Date(i.first).toISOString().slice(0,10)} to ${new Date(i.last).toISOString().slice(0,10)}`:'no data loaded'}${i.err?` <span class="err">${i.err}</span>`:''}</div>`).join('')+`<div>Stored window: trims back to 5 years once it passes 5 years 2 months. New bars are pulled every 3 hours.</div>`}
$('#rf').onclick=async e=>{e.target.textContent='Refreshing…';await fetch('/api/research/refresh',{method:'POST'});e.target.textContent='Refresh latest bars';await meta();load()};
addEventListener('resize',()=>draw());chips();meta();load();
