/* charts.js — primitivas Canvas2D puras (sem dependência externa) pra
 * line / stacked-bar / boxplot / histogram, com tooltip + crosshair
 * compartilhados. Cores lidas dos tokens CSS (funciona em claro/escuro e
 * atualiza sozinho quando o tema muda, porque cada desenho relê os tokens).
 *
 * API pública (todas recebem um <canvas> e re-desenham do zero — chame de
 * novo com os mesmos dados depois de resize/mudança de tema):
 *   Graficos.linha(canvas, { categorias, series, formatoY, casasDecimais })
 *   Graficos.barrasEmpilhadas(canvas, { categorias, series, formatoY })
 *   Graficos.boxplot(canvas, { grupos, formatoY })
 *   Graficos.histograma(canvas, { grupos, formatoY, nBins })
 *   Graficos.quartis(valores) -> { min, q1, mediana, q3, max, minBruto, maxBruto, outliers }
 *     (min/max = whisker clássico; minBruto/maxBruto = valor real sem corte —
 *     é o que todo domínio de eixo/linha de whisker usa, nunca esconde outlier)
 *   Graficos.observarRedesenho(canvas) -> reagenda o último desenho no resize
 */
(function (global) {
  'use strict';

  // ---------- tokens / cor ----------

  function corToken(nome, alpha) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
    if (alpha === undefined || !v.startsWith('#')) return v;
    const r = parseInt(v.slice(1, 3), 16);
    const g = parseInt(v.slice(3, 5), 16);
    const b = parseInt(v.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  const PALETA_CLASSE = {
    'Sênior': '--c-classe-senior',
    'Mezanino': '--c-classe-mezanino',
    'Subordinada': '--c-classe-subordinada',
  };

  function corClasse(nomeClasse, alpha) {
    const varName = PALETA_CLASSE[nomeClasse] || '--c-destaque';
    return corToken(varName, alpha);
  }

  // ---------- estatística client-side ----------

  // Nunca usar Math.min(...array)/Math.max(...array) em array grande: o
  // spread vira argumentos de função e estoura a pilha do V8 acima de ~65 mil
  // elementos (PL/rentabilidade real chega a dezenas de milhares de linhas).
  function minArr(arr) {
    let m = Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return m;
  }
  function maxArr(arr) {
    let m = -Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
  }

  function percentil(ordenados, p) {
    const n = ordenados.length;
    if (n === 1) return ordenados[0];
    const k = (p / 100) * (n - 1);
    const piso = Math.floor(k);
    const teto = Math.ceil(k);
    if (piso === teto) return ordenados[k];
    return ordenados[piso] + (ordenados[teto] - ordenados[piso]) * (k - piso);
  }

  function quartis(valores) {
    const ord = valores.slice().sort((a, b) => a - b);
    if (ord.length === 0) return null;
    const q1 = percentil(ord, 25);
    const med = percentil(ord, 50);
    const q3 = percentil(ord, 75);
    const iqr = q3 - q1;
    const limiteInf = q1 - 1.5 * iqr;
    const limiteSup = q3 + 1.5 * iqr;
    const dentro = ord.filter((v) => v >= limiteInf && v <= limiteSup);
    const outliers = ord.filter((v) => v < limiteInf || v > limiteSup);
    return {
      // min/max = whisker (maior/menor valor NÃO-outlier) — usado só pra
      // desenhar onde o whisker "de verdade" pára dentro da caixa de
      // estatística clássica. minBruto/maxBruto = valor mínimo/máximo REAL da
      // amostra, sem nenhum corte estatístico — é o que dita o domínio do
      // eixo e o fim da linha do whisker no boxplot (ver charts.js:boxplot),
      // pra nunca "esconder"/grampear outlier fora da escala visível.
      min: dentro.length ? dentro[0] : ord[0],
      q1, mediana: med, q3,
      max: dentro.length ? dentro[dentro.length - 1] : ord[ord.length - 1],
      minBruto: ord[0],
      maxBruto: ord[ord.length - 1],
      // Menor valor ESTRITAMENTE positivo da amostra — usado só pra decidir/
      // ancorar escala log (ver dominioAutomatico). Um único 0 (ou negativo)
      // perdido na amostra não pode derrubar o log pro resto: log de 0 é
      // indefinido, mas log só precisa de UM piso positivo pra existir — o
      // valor 0/negativo isolado fica visualmente grampeado nesse piso
      // (mesmo mecanismo de escalaLog/escYGrampeado), sem exigir que TODA a
      // amostra seja positiva. undefined se não existir nenhum valor > 0.
      minPositivoBruto: ord.find((v) => v > 0),
      // Quantos valores são <= 0 — array ORDENADO, então são sempre os
      // primeiros (acha o índice do 1º positivo; -1 vira "todos", ou seja,
      // nenhum é positivo). Usado por dominioAutomatico pra distinguir "1
      // fundo com PL=0 perdido no meio de 4000 positivos" (log ok, outlier
      // isolado) de "rentabilidade tem uma fração REAL negativa" (log
      // incorreto — grandeza pode legitimamente ser negativa, não é ruído).
      nNaoPositivo: (() => { const k = ord.findIndex((v) => v > 0); return k === -1 ? ord.length : k; })(),
      outliers,
      n: ord.length,
    };
  }

  function bins(valores, nBins, minForcado, maxForcado) {
    if (!valores.length) return [];
    const min = minForcado === undefined ? minArr(valores) : minForcado;
    const max = maxForcado === undefined ? maxArr(valores) : maxForcado;
    if (min === max) return [{ x0: min, x1: max, count: valores.length }];
    const largura = (max - min) / nBins;
    const contagens = new Array(nBins).fill(0);
    for (const v of valores) {
      let idx = Math.floor((v - min) / largura);
      if (idx >= nBins) idx = nBins - 1;
      if (idx < 0) idx = 0;
      contagens[idx]++;
    }
    return contagens.map((count, i) => ({ x0: min + i * largura, x1: min + (i + 1) * largura, count }));
  }

  // Bins GEOMETRICAMENTE espaçados em log10 (mesma contagem de bins, largura
  // igual em log, não em R$) — usado quando o domínio é positivo (ver
  // domLogValido). Com cauda direita extrema (PL de FIDC "Universo"), bins()
  // linear jogaria 95%+ da massa no primeiro bin (a maioria dos fundos é
  // pequena/média perto do maior fundo do mercado); espaçar em log faz cada
  // ORDEM DE GRANDEZA (dezenas, centenas, milhares de milhões) ter sua própria
  // faixa de bins, revelando a forma real da distribuição.
  function binsLog(valores, nBins, minForcado, maxForcado) {
    if (!valores.length) return [];
    const min = minForcado === undefined ? minArr(valores) : minForcado;
    const max = maxForcado === undefined ? maxArr(valores) : maxForcado;
    if (min <= 0) return bins(valores, nBins, minForcado, maxForcado); // salvaguarda: nunca deveria ser chamado fora de domLogValido
    if (min === max) return [{ x0: min, x1: max, count: valores.length }];
    const logMin = Math.log10(min);
    const passoLog = (Math.log10(max) - logMin) / nBins;
    const contagens = new Array(nBins).fill(0);
    for (const v of valores) {
      let idx = Math.floor((Math.log10(Math.max(v, min)) - logMin) / passoLog);
      if (idx >= nBins) idx = nBins - 1;
      if (idx < 0) idx = 0;
      contagens[idx]++;
    }
    return contagens.map((count, i) => ({
      x0: Math.pow(10, logMin + i * passoLog),
      x1: Math.pow(10, logMin + (i + 1) * passoLog),
      count,
    }));
  }

  function bomNumeroBins(n) {
    return Math.max(5, Math.min(20, Math.round(Math.sqrt(n))));
  }

  // ---------- tooltip singleton ----------

  let tooltipEl = null;
  let tooltipTimer = null;

  function tooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip-grafico';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function mostrarTooltip(html, clientX, clientY) {
    clearTimeout(tooltipTimer);
    const el = tooltip();
    el.innerHTML = html;
    const margem = 14;
    let left = clientX + margem;
    let top = clientY + margem;
    const maxW = 270;
    if (left + maxW > window.innerWidth) left = clientX - maxW - margem;
    if (top + 80 > window.innerHeight) top = clientY - 80 - margem;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.classList.add('visivel');
  }

  function esconderTooltip() {
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => {
      if (tooltipEl) tooltipEl.classList.remove('visivel');
    }, 200);
  }

  // ---------- canvas / DPR ----------

  function preparaCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rectW = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    const rectH = canvas.clientHeight || 240;
    canvas.width = Math.round(rectW * dpr);
    canvas.height = Math.round(rectH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rectW, rectH);
    return { ctx, w: rectW, h: rectH };
  }

  function formataPadrao(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  }

  function margemPadrao() {
    return { top: 16, right: 16, bottom: 28, left: 52 };
  }

  function escalaLinear(dominio, alcance) {
    const [d0, d1] = dominio;
    const [r0, r1] = alcance;
    const den = d1 - d0 || 1;
    return (v) => r0 + ((v - d0) / den) * (r1 - r0);
  }

  // Escala log10 — só válida pra domínio ESTRITAMENTE positivo (log de 0/
  // negativo não existe). Usada em grandezas tipo PL, que numa amostra
  // "Universo" sem filtro qualitativo tem cauda direita tão extrema (poucos
  // fundos gigantes) que uma escala linear cobrindo o mín/máx bruto (sem
  // recortar outlier) esmaga 95%+ dos pontos perto do zero — log mostra a
  // forma real da distribuição em todas as ordens de grandeza ao mesmo tempo.
  function escalaLog(dominio, alcance) {
    const [d0, d1] = dominio;
    const [r0, r1] = alcance;
    const logD0 = Math.log10(d0);
    const logD1 = Math.log10(d1);
    const den = (logD1 - logD0) || 1;
    return (v) => r0 + ((Math.log10(Math.max(v, d0)) - logD0) / den) * (r1 - r0);
  }

  // Domínio [d0, d1] é utilizável em log10 só se d0 > 0 (log de 0/negativo é
  // indefinido) — usado por boxplot/histograma/boxplotHorizontal pra decidir,
  // automaticamente, se aplicam escala log (grandeza sempre positiva, ex. PL)
  // ou caem pro linear de sempre (grandeza que pode ser 0/negativa, ex.
  // rentabilidade) — nunca escolhido manualmente por critério, só pela forma
  // real do dado em cada gráfico.
  function domLogValido(d0) {
    return d0 > 0 && Number.isFinite(d0);
  }

  // Fração de valores <= 0 acima da qual a escala log NUNCA é usada, mesmo
  // que exista piso positivo — ex.: rentabilidade tem ~9% de valores
  // negativos DE VERDADE (retorno negativo é resultado real, não erro de
  // dado), bem acima disso. 1% cobre o caso legítimo (1 fundo com PL=0
  // perdido em 4000 positivos, ~0,025%) sem deixar log ligar pra grandeza que
  // é genuinamente mista/assinada.
  const FRACAO_MAX_NAO_POSITIVO_PARA_LOG = 0.01;

  // Domínio + padding automático a partir de uma lista de quíntuplas
  // [min, max, minPositivo, nNaoPositivo, n] BRUTAS (um por grupo/mês/classe,
  // o que for; minPositivo pode vir undefined) — fonte única desta decisão,
  // usada tanto pelo auto-cálculo interno de boxplot()/boxplotHorizontal()
  // quanto pelo cálculo de domínio COMPARTILHADO em app.js (dominioYFixo),
  // pra nunca discordar sobre quando usar log e como preencher a margem.
  // Log usa padding MULTIPLICATIVO (constante em log10, não em valor
  // absoluto) — padding aditivo além do maior valor positivo numa escala log
  // distorceria a proporção; padding em log10 preserva a mesma "folga visual"
  // proporcional em qualquer ordem de grandeza.
  //
  // O piso da escala log é o MENOR VALOR POSITIVO da amostra, não o mín bruto
  // — um único 0/negativo perdido no meio de uma amostra majoritariamente
  // positiva (ex.: 1 fundo com PL=0 registrado por engano) não pode
  // derrubar o log pro resto. MAS log só liga se essa fração de não-positivos
  // for pequena (ver FRACAO_MAX_NAO_POSITIVO_PARA_LOG) — sem essa checagem,
  // rentabilidade (~9% de meses com retorno negativo, um dado real, não
  // ruído) ativava log e grampeava TODO valor negativo no mesmo piso
  // positivo, escondendo visualmente uma fração real e relevante da amostra
  // (bug real, achado comparando histograma x boxplot lado a lado).
  function dominioAutomatico(quintuplas) {
    let yMin = Infinity, yMax = -Infinity, menorPositivo = Infinity, somaNaoPositivo = 0, somaN = 0;
    quintuplas.forEach(([mn, mx, mnPos, nNaoPos, n]) => {
      if (mn < yMin) yMin = mn;
      if (mx > yMax) yMax = mx;
      if (mnPos !== undefined && mnPos < menorPositivo) menorPositivo = mnPos;
      if (nNaoPos !== undefined) somaNaoPositivo += nNaoPos;
      if (n !== undefined) somaN += n;
    });
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const fracaoNaoPositivo = somaN > 0 ? somaNaoPositivo / somaN : 0;
    if (Number.isFinite(menorPositivo) && domLogValido(menorPositivo) && fracaoNaoPositivo <= FRACAO_MAX_NAO_POSITIVO_PARA_LOG) {
      const logMin = Math.log10(menorPositivo), logMax = Math.log10(yMax);
      const padLog = (logMax - logMin) * 0.08 || 0.08;
      return [Math.pow(10, logMin - padLog), Math.pow(10, logMax + padLog)];
    }
    const semNegativoDeVerdade = yMin >= 0;
    const pad = (yMax - yMin) * 0.08;
    return [semNegativoDeVerdade ? Math.max(0, yMin - pad) : yMin - pad, yMax + pad];
  }

  function desenhaEixos(ctx, w, h, categorias, dominioY, formatoY, opts) {
    const banda = opts && opts.banda;
    const margem = margemPadrao();
    if (opts && opts.margemBottomExtra) margem.bottom += opts.margemBottomExtra;
    ctx.font = '11px ' + corToken('--font-principal');

    // Escala log10 (opts.escalaLogY): só ativa se o domínio for válido pra log
    // (estritamente positivo) — grandeza que pode ser 0/negativa (ex.
    // rentabilidade) cai pro linear de sempre automaticamente. Em log, os
    // "passos" do eixo são progressão GEOMÉTRICA (log10 igualmente espaçado),
    // não aritmética — é isso que faz o eixo mostrar todas as ordens de
    // grandeza (dezenas, milhares, milhões) com a mesma legibilidade, em vez
    // de esmagar tudo que não é o valor máximo perto do zero.
    const usarLog = !!(opts && opts.escalaLogY) && domLogValido(dominioY[0]);
    const logD0 = usarLog ? Math.log10(dominioY[0]) : 0;
    const logD1 = usarLog ? Math.log10(dominioY[1]) : 0;

    // Margem esquerda cresce pra caber o rótulo mais largo (ex.: "R$ 1.234,5
    // mi") — com margem fixa, valores em moeda/percentual ficam cortados
    // fora do canvas.
    const passosY = 4;
    const rotulosY = [];
    for (let i = 0; i <= passosY; i++) {
      const valor = usarLog
        ? Math.pow(10, logD0 + ((logD1 - logD0) * i) / passosY)
        : dominioY[0] + ((dominioY[1] - dominioY[0]) * i) / passosY;
      rotulosY.push((formatoY || formataPadrao)(valor));
    }
    const maiorLarguraY = rotulosY.reduce((max, texto) => Math.max(max, ctx.measureText(texto).width), 0);
    margem.left = Math.max(margem.left, Math.ceil(maiorLarguraY) + 16);

    const escY = usarLog ? escalaLog(dominioY, [h - margem.bottom, margem.top]) : escalaLinear(dominioY, [h - margem.bottom, margem.top]);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    rotulosY.forEach((texto, i) => {
      const valor = usarLog
        ? Math.pow(10, logD0 + ((logD1 - logD0) * i) / passosY)
        : dominioY[0] + ((dominioY[1] - dominioY[0]) * i) / passosY;
      const y = escY(valor);
      ctx.beginPath();
      ctx.moveTo(margem.left, y);
      ctx.lineTo(w - margem.right, y);
      ctx.strokeStyle = corToken('--c-border', 0.5);
      ctx.stroke();
      ctx.fillStyle = corToken('--c-text-2');
      ctx.fillText(texto, margem.left - 8, y);
    });

    ctx.textBaseline = 'top';
    // Modo "banda" (usado por boxplot vertical): categoria 0 e a última ficam
    // INSETADAS meio-passo de cada borda, não coladas em cima do eixo Y — uma
    // caixa de boxplot tem largura própria (extende pros dois lados do centro),
    // então centralizar a categoria 0 exatamente na borda esquerda faz a caixa
    // vazar por cima do eixo/rótulos do eixo Y. Modo padrão (linha/barra) mantém
    // o primeiro/último ponto rente à borda, que é o esperado pra esses tipos.
    // Banda usa [-0.5, length-0.5] sempre — NUNCA aplicar o guard Math.max(1, ...)
    // aqui (esse guard é só do modo ponto-a-ponto, pra evitar domínio de largura
    // 0 quando só há 1 categoria): com 1 categoria banda já dá [-0.5, 0.5]
    // (largura 1, centralizado em 0) — aplicar o mesmo guard nela dava
    // [-0.5, 1.5] (largura 2), jogando a única caixa pra 25% da área em vez do
    // centro (bug real, achado com filtro de 1 classe só selecionada).
    const escX = banda
      ? escalaLinear([-0.5, categorias.length - 0.5], [margem.left, w - margem.right])
      : escalaLinear([0, Math.max(1, categorias.length - 1)], [margem.left, w - margem.right]);
    const ultimo = categorias.length - 1;

    // Rótulos nas pontas ficam ancorados pra dentro do canvas (senão o texto
    // centralizado vaza pra fora da área desenhável e é cortado) — só faz
    // sentido no modo padrão, ponto-a-ponto; no modo banda todo mundo já tem
    // espaço sobrando dos dois lados, centralizar sempre fica correto.
    function alinhamentoRotulo(i) {
      if (banda) return 'center';
      return i === 0 ? 'left' : i === ultimo ? 'right' : 'center';
    }
    function limitesRotulo(i) {
      const x = escX(i);
      const largura = ctx.measureText(categorias[i]).width;
      const algo = alinhamentoRotulo(i);
      if (algo === 'left') return [x, x + largura];
      if (algo === 'right') return [x - largura, x];
      return [x - largura / 2, x + largura / 2];
    }

    const passoRotulo = Math.max(1, Math.ceil(categorias.length / Math.floor((w - margem.left - margem.right) / 46)));
    const candidatos = [];
    for (let i = 0; i < categorias.length; i += passoRotulo) candidatos.push(i);
    if (candidatos[candidatos.length - 1] !== ultimo) candidatos.push(ultimo);

    // Passada gulosa esquerda->direita: só mantém um candidato se ele não
    // colidir (em pixels reais, considerando o alinhamento de cada um) com o
    // último rótulo já aceito — e o último índice (mais importante) SUBSTITUI
    // o anterior em vez de ser descartado quando colide.
    const indicesRotulo = [];
    candidatos.forEach((i) => {
      if (!indicesRotulo.length) { indicesRotulo.push(i); return; }
      const anteriorIdx = indicesRotulo[indicesRotulo.length - 1];
      const direitaAnterior = limitesRotulo(anteriorIdx)[1];
      const esquerdaAtual = limitesRotulo(i)[0];
      if (esquerdaAtual - direitaAnterior < 6) {
        if (i === ultimo) indicesRotulo[indicesRotulo.length - 1] = i;
      } else {
        indicesRotulo.push(i);
      }
    });

    categorias.forEach((cat, i) => {
      if (indicesRotulo.indexOf(i) === -1) return;
      ctx.textAlign = alinhamentoRotulo(i);
      ctx.fillText(cat, escX(i), h - margem.bottom + 6);
    });
    ctx.textAlign = 'center';

    return { escX, escY, margem };
  }

  function desenhaLegenda(ctx, w, series, margemLeft) {
    let x = margemLeft || margemPadrao().left;
    const y = 8;
    ctx.font = '11px ' + corToken('--font-principal');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    series.forEach((s) => {
      ctx.fillStyle = s.cor;
      ctx.fillRect(x, y - 4, 8, 8);
      ctx.fillStyle = corToken('--c-text-2');
      const largura = ctx.measureText(s.label).width;
      ctx.fillText(s.label, x + 12, y);
      x += 12 + largura + 16;
    });
  }

  // ---------- estado sem-dado ----------

  function semDados(canvas) {
    const wrap = canvas.closest('.grafico-canvas-wrap') || canvas.parentElement;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let msg = wrap.querySelector('.estado-mensagem');
    if (!msg) {
      msg = document.createElement('div');
      msg.className = 'estado-mensagem';
      msg.textContent = 'Sem dados suficientes para este recorte.';
      wrap.appendChild(msg);
    }
    msg.style.display = 'flex';
    canvas.style.display = 'none';
  }

  function comDados(canvas) {
    const wrap = canvas.closest('.grafico-canvas-wrap') || canvas.parentElement;
    const msg = wrap.querySelector('.estado-mensagem');
    if (msg) msg.style.display = 'none';
    canvas.style.display = 'block';
  }

  // ---------- line ----------

  function linha(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'linha', opts };
    const { categorias, series, formatoY, dominioYFixo } = opts;
    const pontosValidos = series.some((s) => s.pontos.some((p) => p !== null && p !== undefined));
    if (!categorias.length || !pontosValidos) return semDados(canvas);
    comDados(canvas);

    const { ctx, w, h } = preparaCanvas(canvas);
    let dominioY;
    if (dominioYFixo) {
      dominioY = dominioYFixo;
    } else {
      const todosValores = series.flatMap((s) => s.pontos).filter((v) => v !== null && v !== undefined);
      let yMin = Math.min(0, minArr(todosValores));
      let yMax = Math.max(maxArr(todosValores), 1e-9);
      if (yMin === yMax) { yMin -= 1; yMax += 1; }
      const pad = (yMax - yMin) * 0.08;
      dominioY = [yMin - pad, yMax + pad];
    }

    const { escX, escY, margem } = desenhaEixos(ctx, w, h, categorias, dominioY, formatoY);
    desenhaLegenda(ctx, w, series.map((s) => ({ label: s.label, cor: s.cor })), margem.left);

    series.forEach((s) => {
      ctx.beginPath();
      ctx.strokeStyle = s.cor;
      ctx.lineWidth = 1.75;
      let comecou = false;
      s.pontos.forEach((v, i) => {
        if (v === null || v === undefined) { comecou = false; return; }
        const x = escX(i);
        const y = escY(v);
        if (!comecou) { ctx.moveTo(x, y); comecou = true; } else { ctx.lineTo(x, y); }
      });
      ctx.stroke();

      s.pontos.forEach((v, i) => {
        if (v === null || v === undefined) return;
        ctx.beginPath();
        ctx.fillStyle = s.cor;
        ctx.arc(escX(i), escY(v), 2.25, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const xLocal = ev.clientX - rect.left;
      const idx = Math.round(escalaLinear([margem.left, w - margem.right], [0, categorias.length - 1])(xLocal));
      const idxClamped = Math.max(0, Math.min(categorias.length - 1, idx));

      redesenhaComCrosshair();
      ctx.beginPath();
      ctx.strokeStyle = corToken('--c-text-2', 0.5);
      ctx.setLineDash([3, 3]);
      ctx.moveTo(escX(idxClamped), margem.top);
      ctx.lineTo(escX(idxClamped), h - margem.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Ordena pelo valor no ponto (maior primeiro) — mesma ordem de cima pra
      // baixo em que as linhas aparecem visualmente naquele x, não a ordem
      // fixa de entrada da série (que não reflete cruzamentos entre linhas).
      const linhasTooltip = [`<strong>${categorias[idxClamped]}</strong>`];
      series
        .map((s) => ({ label: s.label, valor: s.pontos[idxClamped] }))
        .sort((a, b) => {
          if (a.valor === null || a.valor === undefined) return 1;
          if (b.valor === null || b.valor === undefined) return -1;
          return b.valor - a.valor;
        })
        .forEach((s) => {
          linhasTooltip.push(`${s.label}: ${s.valor === null || s.valor === undefined ? '—' : (formatoY || formataPadrao)(s.valor)}`);
        });
      mostrarTooltip(linhasTooltip.join('<br>'), ev.clientX, ev.clientY);

      function redesenhaComCrosshair() {
        preparaCanvas(canvas);
        const nova = desenhaEixos(ctx, w, h, categorias, dominioY, formatoY);
        desenhaLegenda(ctx, w, series.map((s) => ({ label: s.label, cor: s.cor })), nova.margem.left);
        series.forEach((s) => {
          ctx.beginPath();
          ctx.strokeStyle = s.cor;
          ctx.lineWidth = 1.75;
          let comecou = false;
          s.pontos.forEach((v, i) => {
            if (v === null || v === undefined) { comecou = false; return; }
            const x = nova.escX(i);
            const y = nova.escY(v);
            if (!comecou) { ctx.moveTo(x, y); comecou = true; } else { ctx.lineTo(x, y); }
          });
          ctx.stroke();
        });
      }
    };
    canvas.onmouseleave = () => { esconderTooltip(); linha(canvas, opts); };
  }

  // ---------- stacked bar ----------

  function barrasEmpilhadas(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'barrasEmpilhadas', opts };
    const { categorias, series: seriesOriginais, cemPorcento } = opts;
    let formatoY = opts.formatoY;
    const temDado = seriesOriginais.some((s) => s.pontos.some((v) => v));
    if (!categorias.length || !temDado) return semDados(canvas);
    comDados(canvas);

    // Barra 100%: normaliza cada categoria (mês) pra fração do total daquele
    // mês, antes de desenhar — mesmo motor de desenho da barra empilhada
    // comum, só muda o domínio (sempre 0-100%).
    let series = seriesOriginais;
    if (cemPorcento) {
      const totaisOriginais = categorias.map((_, i) => seriesOriginais.reduce((acc, s) => acc + (s.pontos[i] || 0), 0));
      series = seriesOriginais.map((s) => ({
        ...s,
        pontos: s.pontos.map((v, i) => (totaisOriginais[i] > 0 ? (v || 0) / totaisOriginais[i] : 0)),
      }));
      if (!formatoY) formatoY = (v) => (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
    }

    const { ctx, w, h } = preparaCanvas(canvas);
    const totais = categorias.map((_, i) => series.reduce((acc, s) => acc + (s.pontos[i] || 0), 0));
    // cemPorcento NUNCA leva o padding de 8% que os gráficos de valor absoluto
    // levam — 100% já É o teto natural e significativo do domínio; um padding
    // de 2% fazia a régua de 4 passos (desenhaEixos) terminar em 102% (bug
    // real: eixo Y mostrando "mais de 100%" num gráfico de composição/total).
    const yMax = cemPorcento ? 1 : Math.max(maxArr(totais), 1);
    const dominioY = [0, cemPorcento ? 1 : yMax * 1.08];

    const { escX, escY, margem } = desenhaEixos(ctx, w, h, categorias, dominioY, formatoY);
    desenhaLegenda(ctx, w, series.map((s) => ({ label: s.label, cor: s.cor })), margem.left);

    const larguraBarra = Math.max(4, ((w - margem.left - margem.right) / Math.max(1, categorias.length)) * 0.6);

    categorias.forEach((_, i) => {
      let acumulado = 0;
      const x = escX(i) - larguraBarra / 2;
      series.forEach((s) => {
        const v = s.pontos[i] || 0;
        const yBase = escY(acumulado);
        const yTopo = escY(acumulado + v);
        ctx.fillStyle = s.cor;
        ctx.fillRect(x, yTopo, larguraBarra, yBase - yTopo);
        acumulado += v;
      });
    });

    // Eixo secundário (linha) — ex.: "% do PL total" sobreposta às barras
    // absolutas (R$ bi), com sua própria escala à direita.
    const secundaria = opts.linhaSecundaria;
    let escY2 = null;
    if (secundaria && secundaria.valores.some((v) => v !== null && v !== undefined)) {
      const valoresValidos = secundaria.valores.filter((v) => v !== null && v !== undefined);
      const maxSec = Math.max(maxArr(valoresValidos), 1e-9);
      escY2 = escalaLinear([0, maxSec * 1.1], [h - margem.bottom, margem.top]);
      const fmtSec = secundaria.formatoY || formataPadrao;

      ctx.strokeStyle = corToken('--c-acento');
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      let comecou = false;
      secundaria.valores.forEach((v, i) => {
        if (v === null || v === undefined) { comecou = false; return; }
        const x = escX(i), y = escY2(v);
        if (!comecou) { ctx.moveTo(x, y); comecou = true; } else { ctx.lineTo(x, y); }
      });
      ctx.stroke();

      ctx.fillStyle = corToken('--c-acento');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '11px ' + corToken('--font-principal');
      [0, 0.5, 1].forEach((frac) => {
        const valor = maxSec * 1.1 * frac;
        ctx.fillText(fmtSec(valor), w - margem.right + 4, escY2(valor));
      });
    }

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const xLocal = ev.clientX - rect.left;
      const idx = Math.round(escalaLinear([margem.left, w - margem.right], [0, categorias.length - 1])(xLocal));
      const idxClamped = Math.max(0, Math.min(categorias.length - 1, idx));
      // Empilhamento desenha a primeira série na base e a última no topo —
      // lista o tooltip na mesma ordem visual de cima pra baixo (topo
      // primeiro), não a ordem de entrada (que é a ordem da base pra cima).
      const linhasTooltip = [`<strong>${categorias[idxClamped]}</strong>`];
      series.slice().reverse().forEach((s) => {
        linhasTooltip.push(`${s.label}: ${(formatoY || formataPadrao)(s.pontos[idxClamped] || 0)}`);
      });
      linhasTooltip.push(`Total: ${(formatoY || formataPadrao)(totais[idxClamped])}`);
      mostrarTooltip(linhasTooltip.join('<br>'), ev.clientX, ev.clientY);
    };
    canvas.onmouseleave = esconderTooltip;
  }

  // ---------- boxplot ----------

  function boxplot(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'boxplot', opts };
    const { grupos, formatoY } = opts;
    const estatisticas = grupos.map((g) => ({ label: g.label, stats: quartis(g.valores), cor: g.cor }));
    const validos = estatisticas.filter((e) => e.stats);
    if (!validos.length) return semDados(canvas);
    comDados(canvas);

    const { ctx, w, h } = preparaCanvas(canvas);
    // Domínio calculado do MÍNIMO/MÁXIMO BRUTO (sem corte estatístico nenhum)
    // — o boxplot não deve "filtrar"/esconder nenhum valor, só apresentar; um
    // outlier extremo (comum em PL "Universo", sem filtro qualitativo
    // aplicado) estica a escala e espreme a caixa/mediana em poucos pixels,
    // mas isso é uma representação HONESTA de uma distribuição muito
    // concentrada — a alternativa (grampear outlier na borda do canvas) já
    // causou confusão real: dois cortes diferentes do mesmo critério (mês vs
    // período inteiro, por Classe vs por Fundo) cada um calculava seu próprio
    // whisker (Q3+1,5×IQR), e whisker não é comparável/monotônico entre
    // cortes — um corte com "menos dados" podia (matematicamente, sem bug)
    // mostrar um whisker MAIOR que outro com "mais dados", parecendo esconder
    // valor que na verdade só estava calculado sobre outra amostra. Mín/máx
    // bruto não tem essa armadilha: é sempre monotônico (todo subconjunto tem
    // mín/máx dentro do intervalo do conjunto que o contém).
    //
    // opts.dominioYFixo (opcional): usado quando este boxplot precisa
    // compartilhar a MESMA escala de um boxplot IRMÃO (ex.: "mensal" e "geral"
    // do mesmo critério/período) — mesma função dominioAutomatico() de quem
    // computou o domínio compartilhado, garante a mesma decisão log/linear.
    const dominioY = opts.dominioYFixo || dominioAutomatico(validos.map((e) => [e.stats.minBruto, e.stats.maxBruto, e.stats.minPositivoBruto, e.stats.nNaoPositivo, e.stats.n]));
    // Escala log10 automática quando o domínio é estritamente positivo (ex.
    // PL) — grandeza que pode ser 0/negativa (ex. rentabilidade) sempre cai
    // no linear de sempre. Ver escalaLog()/domLogValido() e a mesma decisão
    // em histograma()/boxplotHorizontal().
    const usarLog = domLogValido(dominioY[0]);

    const categorias = estatisticas.map((e) => e.label);
    const { escX, escY, margem } = desenhaEixos(ctx, w, h, categorias, dominioY, formatoY, { banda: true, escalaLogY: usarLog });
    const escYGrampeado = (v) => Math.min(h - margem.bottom, Math.max(margem.top, escY(v)));

    const larguraCaixa = Math.max(16, ((w - margem.left - margem.right) / Math.max(1, categorias.length)) * 0.4);

    estatisticas.forEach((e, i) => {
      const x = escX(i);
      const cor = e.cor || corToken('--c-destaque');
      if (!e.stats) return;
      const { q1, mediana, q3, minBruto, maxBruto, outliers } = e.stats;

      ctx.strokeStyle = cor;
      ctx.lineWidth = 1.25;

      // Whisker vai até o mín/máx BRUTO (não o whisker estatístico clássico)
      // — domínio já cobre esse intervalo inteiro (ver cálculo de dominioY
      // acima), então escYGrampeado aqui é só uma rede de segurança, nunca
      // deveria precisar grampear de verdade.
      ctx.beginPath();
      ctx.moveTo(x, escYGrampeado(minBruto));
      ctx.lineTo(x, escY(q1));
      ctx.moveTo(x, escY(q3));
      ctx.lineTo(x, escYGrampeado(maxBruto));
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x - larguraCaixa / 4, escYGrampeado(minBruto));
      ctx.lineTo(x + larguraCaixa / 4, escYGrampeado(minBruto));
      ctx.moveTo(x - larguraCaixa / 4, escYGrampeado(maxBruto));
      ctx.lineTo(x + larguraCaixa / 4, escYGrampeado(maxBruto));
      ctx.stroke();

      ctx.fillStyle = corToken('--c-surface');
      ctx.fillRect(x - larguraCaixa / 2, escY(q3), larguraCaixa, escY(q1) - escY(q3));
      ctx.strokeRect(x - larguraCaixa / 2, escY(q3), larguraCaixa, escY(q1) - escY(q3));

      ctx.beginPath();
      ctx.moveTo(x - larguraCaixa / 2, escY(mediana));
      ctx.lineTo(x + larguraCaixa / 2, escY(mediana));
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = cor;
      outliers.forEach((v) => {
        ctx.beginPath();
        ctx.arc(x, escYGrampeado(v), 2, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // Um único listener (não um por categoria) — evita acumular handlers a
    // cada redesenho (resize/troca de tema chamam boxplot() de novo pro
    // mesmo canvas via redesenharTodos(), e addEventListener empilhado nunca
    // era removido, degradando desempenho e, com dimensões antigas presas no
    // closure, podendo fazer o hover falhar depois de um resize).
    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const xLocal = ev.clientX - rect.left;
      const encontrado = estatisticas.find((e, i) => e.stats && Math.abs(xLocal - escX(i)) <= larguraCaixa);
      if (!encontrado) { esconderTooltip(); return; }
      const { q1, mediana, q3, minBruto, maxBruto, n } = encontrado.stats;
      mostrarTooltip(
        `<strong>${encontrado.label}</strong><br>máx: ${(formatoY || formataPadrao)(maxBruto)}<br>Q3: ${(formatoY || formataPadrao)(q3)}` +
        `<br>mediana: ${(formatoY || formataPadrao)(mediana)}<br>Q1: ${(formatoY || formataPadrao)(q1)}` +
        `<br>mín: ${(formatoY || formataPadrao)(minBruto)}<br>n: ${n}`,
        ev.clientX, ev.clientY
      );
    };
    canvas.onmouseleave = esconderTooltip;
  }

  // ---------- histogram ----------

  function histograma(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'histograma', opts };
    const { grupos, formatoY, nBins } = opts;
    const gruposComDado = grupos.filter((g) => g.valores.length > 0);
    if (!gruposComDado.length) return semDados(canvas);
    comDados(canvas);

    const { ctx, w, h } = preparaCanvas(canvas);
    const todosValores = gruposComDado.flatMap((g) => g.valores);
    const n = nBins || bomNumeroBins(todosValores.length);

    // Domínio do MÍNIMO/MÁXIMO BRUTO de todos os valores combinados — não
    // filtra/recorta nada, só apresenta (mesmo princípio de boxplot() acima).
    // Um outlier extremo (comum em PL/rentabilidade de FIDC "Universo") pode
    // deixar a maioria das barras concentrada nos primeiros bins e esticar o
    // eixo X bem além delas — isso é a forma honesta da distribuição real,
    // não um defeito do gráfico. Cada grupo é binado com os MESMOS limites
    // globais (min/maxForcado em bins()) pra manter as barras comparáveis
    // entre grupos; nenhum valor é descartado da contagem.
    let minGlobal = minArr(todosValores);
    let maxGlobal = maxArr(todosValores);
    if (minGlobal === maxGlobal) { minGlobal -= 1; maxGlobal += 1; }

    // Menor valor ESTRITAMENTE positivo — ancora o piso da escala log mesmo
    // que exista algum 0/negativo isolado na amostra (ver quartis().
    // minPositivoBruto pra mais contexto); esse ponto isolado fica
    // visualmente grampeado no piso (binsLog já faz Math.max(v, min)). Conta
    // também quantos valores são <= 0 — se for uma fração REAL da amostra
    // (ex. rentabilidade negativa, ~9% dos meses), log NUNCA liga (ver
    // FRACAO_MAX_NAO_POSITIVO_PARA_LOG): log só serve pro caso de 1 valor
    // isolado perdido no meio de uma amostra majoritariamente positiva (ex.
    // PL), nunca pra grandeza que é legitimamente mista/assinada.
    let minPositivoGlobal = Infinity;
    let nNaoPositivoGlobal = 0;
    for (let i = 0; i < todosValores.length; i++) {
      const v = todosValores[i];
      if (v > 0) { if (v < minPositivoGlobal) minPositivoGlobal = v; } else { nNaoPositivoGlobal++; }
    }
    // Escala log10 automática quando existe piso positivo E os não-positivos
    // são raros (ex. PL) — mesma decisão de boxplot(). Sem isso, a cauda
    // direita extrema de uma amostra "Universo" (poucos fundos gigantes)
    // jogava 95%+ da massa no primeiro bin de largura linear, deixando o
    // histograma sem forma nenhuma — binsLog() espaça os bins geometricamente
    // (largura igual em log10, não em R$) especificamente pra resolver isso.
    const fracaoNaoPositivo = todosValores.length ? nNaoPositivoGlobal / todosValores.length : 0;
    const usarLog = Number.isFinite(minPositivoGlobal) && domLogValido(minPositivoGlobal) && fracaoNaoPositivo <= FRACAO_MAX_NAO_POSITIVO_PARA_LOG;
    const minEfetivo = usarLog ? minPositivoGlobal : minGlobal;

    const dominioX = [minEfetivo, maxGlobal];

    const seriesBins = gruposComDado.map((g) => ({
      label: g.label,
      cor: g.cor,
      bins: (usarLog ? binsLog : bins)(g.valores, n, minEfetivo, maxGlobal),
    }));
    const maxContagem = Math.max(maxArr(seriesBins.flatMap((s) => s.bins.map((b) => b.count))), 1);
    const dominioY = [0, maxContagem * 1.1];

    const fmtValor = opts.formatoY || formataPadrao;
    // Ponto médio do eixo: média GEOMÉTRICA em log (fica no meio visual do
    // eixo log), média aritmética no linear de sempre.
    const meioX = usarLog ? Math.sqrt(minEfetivo * maxGlobal) : (minEfetivo + maxGlobal) / 2;
    const rotulosX = [fmtValor(minEfetivo), fmtValor(meioX), fmtValor(maxGlobal)];

    // Média/mediana/desvio por grupo — usados pra desenhar a régua visual
    // (linhas abaixo) e pro tooltip ao passar o mouse sobre ela (ver
    // onmousemove no fim da função); não reservam mais margem fixa pra texto.
    const estatGrupos = gruposComDado.map((g) => {
      const valores = g.valores;
      const nVal = valores.length;
      const media = valores.reduce((acc, v) => acc + v, 0) / nVal;
      const variancia = valores.reduce((acc, v) => acc + (v - media) ** 2, 0) / nVal;
      const desvio = Math.sqrt(variancia);
      const ordenados = valores.slice().sort((a, b) => a - b);
      const mediana = percentil(ordenados, 50);
      return { label: g.label, cor: g.cor, media, mediana, desvio };
    });

    const { escY, margem } = desenhaEixos(ctx, w, h, rotulosX, dominioY, (v) => Math.round(v).toString(), { margemBottomExtra: 8 });
    desenhaLegenda(ctx, w, seriesBins.map((s) => ({ label: s.label, cor: s.cor })), margem.left);

    const escX = usarLog ? escalaLog(dominioX, [margem.left, w - margem.right]) : escalaLinear(dominioX, [margem.left, w - margem.right]);
    // Inversa de escX (pixel -> valor), usada no hover — log10 tem que
    // desfazer a interpolação em log10, não em valor linear.
    const escXInversa = usarLog
      ? (px) => Math.pow(10, Math.log10(dominioX[0]) + ((px - margem.left) / (w - margem.right - margem.left)) * (Math.log10(dominioX[1]) - Math.log10(dominioX[0])))
      : escalaLinear([margem.left, w - margem.right], dominioX);

    const nGrupos = seriesBins.length;
    seriesBins.forEach((s, gi) => {
      s.bins.forEach((b) => {
        const xIni = escX(b.x0);
        const xFim = escX(b.x1);
        const larguraTotal = xFim - xIni;
        const larguraBarra = larguraTotal / nGrupos;
        ctx.fillStyle = s.cor;
        ctx.fillRect(xIni + gi * larguraBarra, escY(b.count), Math.max(1, larguraBarra - 1), escY(0) - escY(b.count));
      });
    });

    // Média (traço), mediana (pontilhado) e faixa de ±1 desvio padrão (barra
    // horizontal) por grupo — desenhados por cima das barras, cada um na cor
    // do próprio grupo, numa faixa de "réguas" empilhada logo abaixo da
    // legenda pra não se sobrepor entre grupos. (estatGrupos já foi calculado
    // acima, antes de desenhaEixos, pra reservar a margem inferior extra.)
    // Réguas de ±1σ, ±2σ e ±3σ CONCÊNTRICAS (mesma linha por grupo, não 3
    // linhas separadas) — mais grossa/opaca por dentro (1σ), mais fina/clara
    // por fora (3σ), pra caber tudo na mesma "trilha" sem inflar a margem.
    const NIVEIS_DESVIO = [
      { k: 3, largura: 1, alpha: 0.35, tamanhoTick: 3 },
      { k: 2, largura: 2, alpha: 0.6, tamanhoTick: 4 },
      { k: 1, largura: 3, alpha: 1, tamanhoTick: 5 },
    ];
    const alturaRegua = 14;
    estatGrupos.forEach((e, gi) => {
      const yRegua = margem.top + 4 + gi * alturaRegua;
      const xMedia = escX(e.media);
      const xMediana = escX(e.mediana);

      NIVEIS_DESVIO.forEach((nivel) => {
        const xIni = escX(Math.max(dominioX[0], e.media - nivel.k * e.desvio));
        const xFim = escX(Math.min(dominioX[1], e.media + nivel.k * e.desvio));
        ctx.strokeStyle = corToken(PALETA_CLASSE[e.label] || '--c-destaque', nivel.alpha);
        ctx.lineWidth = nivel.largura;
        ctx.beginPath();
        ctx.moveTo(xIni, yRegua);
        ctx.lineTo(xFim, yRegua);
        ctx.stroke();
        [xIni, xFim].forEach((x) => {
          ctx.beginPath();
          ctx.moveTo(x, yRegua - nivel.tamanhoTick);
          ctx.lineTo(x, yRegua + nivel.tamanhoTick);
          ctx.stroke();
        });
      });

      ctx.setLineDash([4, 2]);
      ctx.strokeStyle = e.cor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xMedia, margem.top);
      ctx.lineTo(xMedia, h - margem.bottom);
      ctx.stroke();

      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(xMediana, margem.top);
      ctx.lineTo(xMediana, h - margem.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Média/mediana/±1σ/±2σ/±3σ NÃO ficam mais escritos permanentemente
    // embaixo do eixo — só a régua visual (linhas acima) fica sempre visível,
    // compacta (uma trilha de ~14px por grupo). Os valores exatos aparecem no
    // tooltip ao passar o mouse sobre a trilha de réguas (ver onmousemove
    // abaixo) — antes, cada grupo linha (Média/Mediana/1σ/2σ/3σ) reservava uma
    // margem inferior fixa de até 280px pra caber números que colidiam entre
    // si; isso ocupava espaço vertical enorme e sobrava vazio na maioria dos
    // recortes. Hover é o mesmo padrão já usado no boxplot (tooltip com
    // min/Q1/mediana/Q3/max ao passar o mouse), então fica consistente entre
    // os dois tipos de gráfico.
    const alturaTrilhaReguas = margem.top + 4 + nGrupos * alturaRegua;

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const xLocal = ev.clientX - rect.left;
      const yLocal = ev.clientY - rect.top;

      if (yLocal <= alturaTrilhaReguas) {
        const gi = Math.max(0, Math.min(nGrupos - 1, Math.floor((yLocal - margem.top - 4) / alturaRegua)));
        const e = estatGrupos[gi];
        if (e) {
          mostrarTooltip(
            [
              `<strong>${e.label}</strong>`,
              `Média: ${fmtValor(e.media)}`,
              `Mediana: ${fmtValor(e.mediana)}`,
              `±1σ: ${fmtValor(e.media - e.desvio)} a ${fmtValor(e.media + e.desvio)}`,
              `±2σ: ${fmtValor(e.media - 2 * e.desvio)} a ${fmtValor(e.media + 2 * e.desvio)}`,
              `±3σ: ${fmtValor(e.media - 3 * e.desvio)} a ${fmtValor(e.media + 3 * e.desvio)}`,
            ].join('<br>'),
            ev.clientX, ev.clientY
          );
          return;
        }
      }

      const valor = escXInversa(xLocal);
      const linhasTooltip = [`<strong>${fmtValor(valor)}</strong>`];
      seriesBins.forEach((s) => {
        const b = s.bins.find((bb) => valor >= bb.x0 && valor <= bb.x1);
        linhasTooltip.push(`${s.label}: ${b ? b.count : 0}`);
      });
      mostrarTooltip(linhasTooltip.join('<br>'), ev.clientX, ev.clientY);
    };
    canvas.onmouseleave = esconderTooltip;
  }

  // ---------- boxplot horizontal (categoria no eixo Y, valor no eixo X) ----------

  function boxplotHorizontal(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'boxplotHorizontal', opts };
    const { grupos, formatoY } = opts;
    const estatisticas = grupos.map((g) => ({ label: g.label, stats: quartis(g.valores), cor: g.cor }));
    const validos = estatisticas.filter((e) => e.stats);
    if (!validos.length) return semDados(canvas);
    comDados(canvas);

    const { ctx, w, h } = preparaCanvas(canvas);
    const margem = margemPadrao();
    const maiorRotulo = validos.reduce((max, e) => Math.max(max, e.label.length * 6.5), 0);
    margem.left = Math.max(margem.left, maiorRotulo + 12);

    // Domínio do mínimo/máximo BRUTO — ver mesma justificativa em boxplot().
    // Escala log10 automática quando o domínio é estritamente positivo (ex.
    // PL) — mesma decisão de boxplot()/histograma(), ver escalaLog().
    const [xMinComPad, xMaxComPad] = dominioAutomatico(validos.map((e) => [e.stats.minBruto, e.stats.maxBruto, e.stats.minPositivoBruto, e.stats.nNaoPositivo, e.stats.n]));
    const usarLog = domLogValido(xMinComPad);
    const escX = usarLog
      ? escalaLog([xMinComPad, xMaxComPad], [margem.left, w - margem.right])
      : escalaLinear([xMinComPad, xMaxComPad], [margem.left, w - margem.right]);
    const escXGrampeado = (v) => Math.min(w - margem.right, Math.max(margem.left, escX(v)));
    // Banda (não ponto-a-ponto) no eixo de categorias — mesma justificativa do
    // boxplot vertical: a caixa tem espessura própria nos dois lados do centro,
    // categoria 0/última não pode ficar colada na borda superior/inferior.
    const escY = escalaLinear([-0.5, validos.length - 0.5], [margem.top + 10, h - margem.bottom]);

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '11px ' + corToken('--font-principal');
    ctx.fillStyle = corToken('--c-text-2');
    validos.forEach((e, i) => ctx.fillText(e.label, margem.left - 8, escY(i)));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const passosX = 4;
    const logXMin = usarLog ? Math.log10(xMinComPad) : 0;
    const logXMax = usarLog ? Math.log10(xMaxComPad) : 0;
    for (let i = 0; i <= passosX; i++) {
      const valor = usarLog
        ? Math.pow(10, logXMin + ((logXMax - logXMin) * i) / passosX)
        : xMinComPad + ((xMaxComPad - xMinComPad) * i) / passosX;
      const x = escX(valor);
      ctx.strokeStyle = corToken('--c-border', 0.5);
      ctx.beginPath();
      ctx.moveTo(x, margem.top);
      ctx.lineTo(x, h - margem.bottom + 4);
      ctx.stroke();
      ctx.fillStyle = corToken('--c-text-2');
      ctx.fillText((formatoY || formataPadrao)(valor), x, h - margem.bottom + 6);
    }

    const larguraCaixa = Math.max(10, (h - margem.top - margem.bottom) / Math.max(1, validos.length) * 0.4);

    validos.forEach((e, i) => {
      const y = escY(i);
      const cor = e.cor || corToken('--c-destaque');
      const { q1, mediana, q3, minBruto, maxBruto, outliers } = e.stats;

      ctx.strokeStyle = cor;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(escXGrampeado(minBruto), y);
      ctx.lineTo(escX(q1), y);
      ctx.moveTo(escX(q3), y);
      ctx.lineTo(escXGrampeado(maxBruto), y);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(escXGrampeado(minBruto), y - larguraCaixa / 4);
      ctx.lineTo(escXGrampeado(minBruto), y + larguraCaixa / 4);
      ctx.moveTo(escXGrampeado(maxBruto), y - larguraCaixa / 4);
      ctx.lineTo(escXGrampeado(maxBruto), y + larguraCaixa / 4);
      ctx.stroke();

      ctx.fillStyle = corToken('--c-surface');
      ctx.fillRect(escX(q1), y - larguraCaixa / 2, escX(q3) - escX(q1), larguraCaixa);
      ctx.strokeRect(escX(q1), y - larguraCaixa / 2, escX(q3) - escX(q1), larguraCaixa);

      ctx.beginPath();
      ctx.moveTo(escX(mediana), y - larguraCaixa / 2);
      ctx.moveTo(escX(mediana), y - larguraCaixa / 2);
      ctx.lineTo(escX(mediana), y + larguraCaixa / 2);
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = cor;
      outliers.forEach((v) => {
        ctx.beginPath();
        ctx.arc(escXGrampeado(v), y, 2, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // Um único listener — ver mesma justificativa (vazamento de handlers) em boxplot().
    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const yLocal = ev.clientY - rect.top;
      const encontrado = validos.find((e, i) => Math.abs(yLocal - escY(i)) <= larguraCaixa);
      if (!encontrado) { esconderTooltip(); return; }
      const { q1, mediana, q3, minBruto, maxBruto, n } = encontrado.stats;
      mostrarTooltip(
        `<strong>${encontrado.label}</strong><br>máx: ${(formatoY || formataPadrao)(maxBruto)}<br>Q3: ${(formatoY || formataPadrao)(q3)}` +
        `<br>mediana: ${(formatoY || formataPadrao)(mediana)}<br>Q1: ${(formatoY || formataPadrao)(q1)}` +
        `<br>mín: ${(formatoY || formataPadrao)(minBruto)}<br>n: ${n}`,
        ev.clientX, ev.clientY
      );
    };
    canvas.onmouseleave = esconderTooltip;
  }

  // ---------- barra horizontal com rótulo de valor (verde/vermelho) ----------

  function barraHorizontalComRotulo(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'barraHorizontalComRotulo', opts };
    const { categorias, valores, formatoValor } = opts;
    if (!categorias.length) return semDados(canvas);
    comDados(canvas);

    const { ctx, w, h } = preparaCanvas(canvas);
    const margem = margemPadrao();
    const maiorRotulo = categorias.reduce((max, c) => Math.max(max, c.length * 6.5), 0);
    margem.left = Math.max(margem.left, maiorRotulo + 12);
    margem.right = 90;

    const maxAbs = Math.max(maxArr(valores.map((v) => Math.abs(v || 0))), 1e-9);
    const escX = escalaLinear([-maxAbs * 1.15, maxAbs * 1.15], [margem.left, w - margem.right]);
    const escY = escalaLinear([0, categorias.length - 1], [margem.top + 10, h - margem.bottom]);
    const zeroX = escX(0);

    ctx.strokeStyle = corToken('--c-border');
    ctx.beginPath();
    ctx.moveTo(zeroX, margem.top);
    ctx.lineTo(zeroX, h - margem.bottom);
    ctx.stroke();

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '11px ' + corToken('--font-principal');

    const alturaBarra = Math.max(8, ((h - margem.top - margem.bottom) / categorias.length) * 0.55);

    categorias.forEach((cat, i) => {
      const y = escY(i);
      const v = valores[i] || 0;
      const positivo = v >= 0;
      ctx.fillStyle = corToken('--c-text-2');
      ctx.textAlign = 'right';
      ctx.fillText(cat, margem.left - 8, y);

      ctx.fillStyle = corToken(positivo ? '--c-ok' : '--c-bad');
      const xIni = positivo ? zeroX : escX(v);
      const largura = Math.abs(escX(v) - zeroX);
      ctx.fillRect(xIni, y - alturaBarra / 2, largura, alturaBarra);

      ctx.textAlign = 'left';
      ctx.fillText((formatoValor || formataPadrao)(v), (positivo ? escX(v) : zeroX) + Math.max(largura, 0) + 6, y);
    });

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const yLocal = ev.clientY - rect.top;
      const idx = Math.round(escalaLinear([margem.top + 10, h - margem.bottom], [0, categorias.length - 1])(yLocal));
      const idxClamped = Math.max(0, Math.min(categorias.length - 1, idx));
      mostrarTooltip(`<strong>${categorias[idxClamped]}</strong><br>${(formatoValor || formataPadrao)(valores[idxClamped] || 0)}`, ev.clientX, ev.clientY);
    };
    canvas.onmouseleave = esconderTooltip;
  }

  // Barra empilhada HORIZONTAL (categoria no eixo Y, valor no eixo X) — pra
  // composição por categoria (ex. Sênior/Mezanino/Subordinada por Tipo de
  // Ativo) quando os NOMES das categorias são longos e/ou numerosos demais
  // pra caber no eixo X de uma barra vertical comum (mesmo motivo de
  // boxplotHorizontal/barraHorizontalComRotulo). cemPorcento (sempre true
  // no uso atual) normaliza cada linha pra fração de 0-100%, igual
  // barrasEmpilhadas — só muda a orientação dos eixos.
  function barrasEmpilhadasHorizontal(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'barrasEmpilhadasHorizontal', opts };
    const { categorias, series: seriesOriginais, cemPorcento } = opts;
    let formatoValor = opts.formatoValor;
    const temDado = categorias.length && seriesOriginais.some((s) => s.pontos.some((v) => v));
    if (!temDado) return semDados(canvas);
    comDados(canvas);

    let series = seriesOriginais;
    if (cemPorcento) {
      const totaisOriginais = categorias.map((_, i) => seriesOriginais.reduce((acc, s) => acc + (s.pontos[i] || 0), 0));
      series = seriesOriginais.map((s) => ({
        ...s,
        pontos: s.pontos.map((v, i) => (totaisOriginais[i] > 0 ? (v || 0) / totaisOriginais[i] : 0)),
      }));
      if (!formatoValor) formatoValor = (v) => (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
    }

    const { ctx, w, h } = preparaCanvas(canvas);
    const margem = margemPadrao();
    margem.top += 24; // espaço pra legenda
    const maiorRotulo = categorias.reduce((max, c) => Math.max(max, c.length * 6.5), 0);
    margem.left = Math.max(margem.left, maiorRotulo + 12);

    desenhaLegenda(ctx, w, series.map((s) => ({ label: s.label, cor: s.cor })), margem.left);

    const xMax = cemPorcento ? 1 : Math.max(maxArr(categorias.map((_, i) => series.reduce((acc, s) => acc + (s.pontos[i] || 0), 0))), 1);
    const escX = escalaLinear([0, cemPorcento ? 1 : xMax * 1.08], [margem.left, w - margem.right]);
    const escY = escalaLinear([0, categorias.length - 1], [margem.top + 10, h - margem.bottom]);

    // Réguas verticais (0/25/50/75/100% ou 4 passos lineares) + rótulos.
    const passosX = 4;
    ctx.font = '11px ' + corToken('--font-principal');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= passosX; i++) {
      const valor = (cemPorcento ? 1 : xMax * 1.08) * (i / passosX);
      const x = escX(valor);
      ctx.strokeStyle = corToken('--c-border', 0.5);
      ctx.beginPath();
      ctx.moveTo(x, margem.top);
      ctx.lineTo(x, h - margem.bottom);
      ctx.stroke();
      ctx.fillStyle = corToken('--c-text-2');
      ctx.fillText((formatoValor || formataPadrao)(valor), x, h - margem.bottom + 6);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const alturaBarra = Math.max(10, ((h - margem.top - margem.bottom) / categorias.length) * 0.6);

    categorias.forEach((cat, i) => {
      const y = escY(i);
      ctx.fillStyle = corToken('--c-text-2');
      ctx.fillText(cat, margem.left - 8, y);

      let acumulado = 0;
      series.forEach((s) => {
        const v = s.pontos[i] || 0;
        const xBase = escX(acumulado);
        const xTopo = escX(acumulado + v);
        ctx.fillStyle = s.cor;
        ctx.fillRect(xBase, y - alturaBarra / 2, xTopo - xBase, alturaBarra);
        acumulado += v;
      });
    });

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const yLocal = ev.clientY - rect.top;
      const idx = Math.round(escalaLinear([margem.top + 10, h - margem.bottom], [0, categorias.length - 1])(yLocal));
      const idxClamped = Math.max(0, Math.min(categorias.length - 1, idx));
      const linhas = series.map((s) => `${s.label}: ${(formatoValor || formataPadrao)(s.pontos[idxClamped] || 0)}`).join('<br>');
      mostrarTooltip(`<strong>${categorias[idxClamped]}</strong><br>${linhas}`, ev.clientX, ev.clientY);
    };
    canvas.onmouseleave = esconderTooltip;
  }

  // ---------- heatmap ----------

  function _corEscalaContinua(t, negativo) {
    // t em [0,1]. Usa --c-bad -> --c-surface -> --c-ok se `negativo` permitido,
    // senão --c-surface -> --c-ok (só valores >=0, ex. spread sempre positivo
    // não se aplica aqui — spread pode ser negativo, então sempre bipolar).
    const ruim = corToken('--c-bad');
    const meio = corToken('--c-surface');
    const bom = corToken('--c-ok');
    function hexParaRgb(hex) {
      return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }
    function misturar(c1, c2, frac) {
      const [r1, g1, b1] = hexParaRgb(c1);
      const [r2, g2, b2] = hexParaRgb(c2);
      return `rgb(${Math.round(r1 + (r2 - r1) * frac)},${Math.round(g1 + (g2 - g1) * frac)},${Math.round(b1 + (b2 - b1) * frac)})`;
    }
    if (t < 0.5) return misturar(ruim, meio, t / 0.5);
    return misturar(meio, bom, (t - 0.5) / 0.5);
  }

  function heatmap(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'heatmap', opts };
    const { linhas, colunas, valores, formatoValor, contagens } = opts; // valores[linha][coluna]
    if (!linhas.length || !colunas.length) return semDados(canvas);
    comDados(canvas);

    const { ctx, w, h } = preparaCanvas(canvas);
    const margem = margemPadrao();
    const maiorRotulo = linhas.reduce((max, l) => Math.max(max, l.length * 6.5), 0);
    margem.left = Math.max(margem.left, maiorRotulo + 12);
    margem.bottom = 60;
    const alturaEscala = 14;

    const todos = linhas.flatMap((_, i) => colunas.map((_, j) => valores[i][j])).filter((v) => v !== null && v !== undefined);
    if (!todos.length) return semDados(canvas);
    const maxAbs = Math.max(maxArr(todos.map(Math.abs)), 1e-9);

    const larguraCelula = (w - margem.left - margem.right) / colunas.length;
    const alturaCelula = (h - margem.top - margem.bottom) / linhas.length;

    ctx.font = '11px ' + corToken('--font-principal');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    linhas.forEach((linha, i) => {
      ctx.fillStyle = corToken('--c-text-2');
      ctx.fillText(linha, margem.left - 8, margem.top + alturaCelula * (i + 0.5));
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    colunas.forEach((coluna, j) => {
      ctx.fillStyle = corToken('--c-text-2');
      ctx.fillText(coluna, margem.left + larguraCelula * (j + 0.5), margem.top + alturaCelula * linhas.length + 6);
    });

    linhas.forEach((_, i) => {
      colunas.forEach((_, j) => {
        const v = valores[i][j];
        const x = margem.left + larguraCelula * j;
        const y = margem.top + alturaCelula * i;
        if (v === null || v === undefined) {
          ctx.fillStyle = corToken('--c-border', 0.3);
        } else {
          const t = Math.max(0, Math.min(1, (v + maxAbs) / (2 * maxAbs)));
          ctx.fillStyle = _corEscalaContinua(t);
        }
        ctx.fillRect(x, y, larguraCelula - 1, alturaCelula - 1);
      });
    });

    // legenda de escala
    const yEscala = h - margem.bottom + 28;
    const larguraEscala = Math.min(220, w - margem.left - margem.right);
    for (let px = 0; px < larguraEscala; px++) {
      const t = px / larguraEscala;
      ctx.fillStyle = _corEscalaContinua(t);
      ctx.fillRect(margem.left + px, yEscala, 1, alturaEscala);
    }
    ctx.strokeStyle = corToken('--c-border');
    ctx.strokeRect(margem.left, yEscala, larguraEscala, alturaEscala);
    ctx.fillStyle = corToken('--c-text-2');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText((formatoValor || formataPadrao)(-maxAbs), margem.left, yEscala + alturaEscala + 4);
    ctx.textAlign = 'right';
    ctx.fillText((formatoValor || formataPadrao)(maxAbs), margem.left + larguraEscala, yEscala + alturaEscala + 4);

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const xLocal = ev.clientX - rect.left - margem.left;
      const yLocal = ev.clientY - rect.top - margem.top;
      const j = Math.floor(xLocal / larguraCelula);
      const i = Math.floor(yLocal / alturaCelula);
      if (i < 0 || i >= linhas.length || j < 0 || j >= colunas.length) { esconderTooltip(); return; }
      const v = valores[i][j];
      const n = contagens ? contagens[i][j] : null;
      const texto = v === null || v === undefined
        ? `<strong>${linhas[i]} × ${colunas[j]}</strong><br>sem dado`
        : `<strong>${linhas[i]} × ${colunas[j]}</strong><br>${(formatoValor || formataPadrao)(v)}${n !== null ? `<br>n: ${n}` : ''}`;
      mostrarTooltip(texto, ev.clientX, ev.clientY);
    };
    canvas.onmouseleave = esconderTooltip;
  }

  // ---------- bubble scatter + regressão OLS ----------

  function scatter(canvas, opts) {
    canvas._ultimoDesenho = { tipo: 'scatter', opts };
    const { pontos, formatoX, formatoY, rotuloX, rotuloY, mostrarRegressao, linhasReferencia } = opts;
    if (!pontos.length) return semDados(canvas);
    comDados(canvas);

    const { ctx, w, h } = preparaCanvas(canvas);
    const margem = margemPadrao();
    margem.left = 56;
    margem.bottom = 40;

    const xs = pontos.map((p) => p.x);
    const ys = pontos.map((p) => p.y);
    const raios = pontos.map((p) => (p.raio === undefined ? 5 : p.raio));

    let xMin = minArr(xs), xMax = maxArr(xs);
    let yMin = minArr(ys), yMax = maxArr(ys);
    if (xMin === xMax) { xMin -= 1; xMax += 1; }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const padX = (xMax - xMin) * 0.08, padY = (yMax - yMin) * 0.08;

    const escX = escalaLinear([xMin - padX, xMax + padX], [margem.left, w - margem.right]);
    const escY = escalaLinear([yMin - padY, yMax + padY], [h - margem.bottom, margem.top]);

    ctx.font = '11px ' + corToken('--font-principal');
    ctx.strokeStyle = corToken('--c-border');
    ctx.fillStyle = corToken('--c-text-2');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const valor = (yMin - padY) + (((yMax + padY) - (yMin - padY)) * i) / 4;
      const y = escY(valor);
      ctx.beginPath();
      ctx.moveTo(margem.left, y);
      ctx.lineTo(w - margem.right, y);
      ctx.strokeStyle = corToken('--c-border', 0.5);
      ctx.stroke();
      ctx.fillText((formatoY || formataPadrao)(valor), margem.left - 8, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const valor = (xMin - padX) + (((xMax + padX) - (xMin - padX)) * i) / 4;
      ctx.fillText((formatoX || formataPadrao)(valor), escX(valor), h - margem.bottom + 6);
    }

    if (linhasReferencia) {
      linhasReferencia.forEach((ref) => {
        ctx.strokeStyle = ref.cor;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        if (ref.eixo === 'y') {
          const y = escY(ref.valor);
          ctx.moveTo(margem.left, y);
          ctx.lineTo(w - margem.right, y);
        } else {
          const x = escX(ref.valor);
          ctx.moveTo(x, margem.top);
          ctx.lineTo(x, h - margem.bottom);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }

    let regressao = null;
    if (mostrarRegressao && pontos.length >= 2) {
      regressao = regressaoLinearJs(xs, ys);
      if (regressao) {
        ctx.strokeStyle = corToken('--c-text');
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(escX(xMin - padX), escY(regressao.intercepto + regressao.inclinacao * (xMin - padX)));
        ctx.lineTo(escX(xMax + padX), escY(regressao.intercepto + regressao.inclinacao * (xMax + padX)));
        ctx.stroke();
        ctx.fillStyle = corToken('--c-text');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`R² = ${regressao.r2.toFixed(2)} · inclinação = ${regressao.inclinacao.toFixed(3)}`, margem.left + 4, margem.top + 4);
      }
    }

    pontos.forEach((p) => {
      ctx.beginPath();
      ctx.fillStyle = p.cor || corToken('--c-destaque', 0.7);
      ctx.arc(escX(p.x), escY(p.y), p.raio === undefined ? 5 : p.raio, 0, Math.PI * 2);
      ctx.fill();
    });

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const xLocal = ev.clientX - rect.left, yLocal = ev.clientY - rect.top;
      let maisProximo = null, menorDist = Infinity;
      pontos.forEach((p) => {
        const dx = escX(p.x) - xLocal, dy = escY(p.y) - yLocal;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < menorDist) { menorDist = dist; maisProximo = p; }
      });
      if (!maisProximo || menorDist > 20) { esconderTooltip(); return; }
      mostrarTooltip(maisProximo.tooltip || `${rotuloX || 'x'}: ${(formatoX || formataPadrao)(maisProximo.x)}<br>${rotuloY || 'y'}: ${(formatoY || formataPadrao)(maisProximo.y)}`, ev.clientX, ev.clientY);
    };
    canvas.onmouseleave = esconderTooltip;

    return regressao;
  }

  function regressaoLinearJs(x, y) {
    const n = x.length;
    if (n < 2) return null;
    const mediaX = x.reduce((a, b) => a + b, 0) / n;
    const mediaY = y.reduce((a, b) => a + b, 0) / n;
    let covXY = 0, varX = 0;
    for (let i = 0; i < n; i++) {
      covXY += (x[i] - mediaX) * (y[i] - mediaY);
      varX += (x[i] - mediaX) * (x[i] - mediaX);
    }
    if (varX === 0) return null;
    const inclinacao = covXY / varX;
    const intercepto = mediaY - inclinacao * mediaX;
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      const predito = intercepto + inclinacao * x[i];
      ssRes += (y[i] - predito) ** 2;
      ssTot += (y[i] - mediaY) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
    return { inclinacao, intercepto, r2 };
  }

  // ---------- redesenho em resize/tema ----------

  const canvasObservados = new Set();
  const dispatch = {
    linha,
    barrasEmpilhadas,
    boxplot,
    histograma,
    boxplotHorizontal,
    barraHorizontalComRotulo,
    barrasEmpilhadasHorizontal,
    heatmap,
    scatter,
  };

  function redesenharTodos() {
    canvasObservados.forEach((canvas) => {
      const ultimo = canvas._ultimoDesenho;
      if (ultimo) dispatch[ultimo.tipo](canvas, ultimo.opts);
    });
  }

  function observarRedesenho(canvas) {
    canvasObservados.add(canvas);
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redesenharTodos, 120);
  });

  global.Graficos = {
    linha,
    barrasEmpilhadas,
    boxplot,
    histograma,
    boxplotHorizontal,
    barraHorizontalComRotulo,
    barrasEmpilhadasHorizontal,
    heatmap,
    scatter,
    regressaoLinearJs,
    quartis,
    bins,
    dominioAutomatico,
    corClasse,
    corToken,
    observarRedesenho,
    redesenharTodos,
  };
})(window);
