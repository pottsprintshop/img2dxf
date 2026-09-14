(function () {
  'use strict';

  var MAX_DIM = 1200; // downscale large photos before tracing, for phone performance
  var QUAD_STEPS = 8; // how many line segments to flatten each curve into

  var fileInput = document.getElementById('fileInput');
  var chooseBtn = document.getElementById('chooseBtn');
  var fileName = document.getElementById('fileName');
  var controls = document.getElementById('controls');
  var thresholdEl = document.getElementById('threshold');
  var thresholdVal = document.getElementById('thresholdVal');
  var simplifyEl = document.getElementById('simplify');
  var simplifyVal = document.getElementById('simplifyVal');
  var invertEl = document.getElementById('invert');
  var rightAngleEl = document.getElementById('rightAngle');
  var outWidthEl = document.getElementById('outWidth');
  var unitEl = document.getElementById('unit');
  var outHeightEl = document.getElementById('outHeight');
  var scaleBtns = document.querySelectorAll('.scale-btn');
  var otherBtn = document.getElementById('otherBtn');
  var formatEl = document.getElementById('format');
  var downloadBtn = document.getElementById('downloadBtn');
  var pathInfo = document.getElementById('pathInfo');
  var srcCanvas = document.getElementById('srcCanvas');
  var traceCanvas = document.getElementById('traceCanvas');

  var srcCtx = srcCanvas.getContext('2d');
  var traceCtx = traceCanvas.getContext('2d');

  var workImg = null;      // HTMLImageElement
  var workW = 0, workH = 0;
  var uploadedW = 0;       // original uploaded pixel width, independent of internal downscale
  var latestPaths = null;  // array of {points:[{x,y},...]} in pixel space, ready for DXF/preview
  var retraceTimer = null;

  chooseBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
  });

  [thresholdEl, simplifyEl, invertEl, rightAngleEl].forEach(function (el) {
    el.addEventListener('input', scheduleRetrace);
  });
  unitEl.addEventListener('input', updateOutputSize);
  outWidthEl.addEventListener('input', function () {
    setActiveScaleBtn(otherBtn);
    updateOutputSize();
  });
  scaleBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setActiveScaleBtn(btn);
      if (btn.dataset.mult) {
        outWidthEl.value = Math.round(uploadedW * parseFloat(btn.dataset.mult));
        updateOutputSize();
      } else {
        outWidthEl.focus();
        outWidthEl.select();
      }
    });
  });
  formatEl.addEventListener('change', updateDownloadLabel);
  downloadBtn.addEventListener('click', exportFile);

  function setActiveScaleBtn(btn) {
    scaleBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
  }

  function loadFile(file) {
    fileName.textContent = file.name;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      workW = Math.max(1, Math.round(img.naturalWidth * scale));
      workH = Math.max(1, Math.round(img.naturalHeight * scale));
      uploadedW = img.naturalWidth;
      workImg = img;
      controls.hidden = false;
      srcCanvas.width = workW; srcCanvas.height = workH;
      traceCanvas.width = workW; traceCanvas.height = workH;
      srcCtx.drawImage(img, 0, 0, workW, workH);
      outWidthEl.value = uploadedW;
      setActiveScaleBtn(document.querySelector('.scale-btn[data-mult="1"]'));
      updateOutputSize();
      scheduleRetrace();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      alert('Could not load that image.');
    };
    img.src = url;
  }

  function scheduleRetrace() {
    thresholdVal.textContent = thresholdEl.value;
    simplifyVal.textContent = simplifyEl.value;
    if (!workImg) return;
    clearTimeout(retraceTimer);
    retraceTimer = setTimeout(retrace, 120);
  }

  function retrace() {
    var threshold = parseInt(thresholdEl.value, 10);
    var invert = invertEl.checked;

    // Binarize a fresh copy of the working image. Flatten onto white first so
    // transparent PNG regions (logos, clipart) read as background, not black.
    var work = document.createElement('canvas');
    work.width = workW; work.height = workH;
    var wctx = work.getContext('2d');
    wctx.fillStyle = '#fff';
    wctx.fillRect(0, 0, workW, workH);
    wctx.drawImage(workImg, 0, 0, workW, workH);
    var imgd = wctx.getImageData(0, 0, workW, workH);
    var d = imgd.data;
    for (var i = 0; i < d.length; i += 4) {
      var lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      var isFg = invert ? (lum >= threshold) : (lum < threshold);
      var v = isFg ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    wctx.putImageData(imgd, 0, 0);

    var detail = parseInt(simplifyEl.value, 10); // 0..10, higher = more detail
    var pathomit = Math.round(60 - (detail / 10) * 58);
    var tol = 5.0 - (detail / 10) * 4.8;

    var options = {
      numberofcolors: 2,
      pathomit: pathomit,
      ltres: tol,
      qtres: tol,
      rightangleenhance: rightAngleEl.checked,
      colorsampling: 0
    };

    var tracedata = ImageTracer.imagedataToTracedata(imgd, options);

    // Pick the darkest palette color as the "foreground" layer to export.
    var fgIndex = 0, bestLum = Infinity;
    tracedata.palette.forEach(function (c, idx) {
      var lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      if (lum < bestLum) { bestLum = lum; fgIndex = idx; }
    });

    var layer = tracedata.layers[fgIndex] || [];
    var paths = [];
    layer.forEach(function (smp) {
      var segs = smp.segments;
      if (!segs || !segs.length) return;
      var pts = [{ x: segs[0].x1, y: segs[0].y1 }];
      segs.forEach(function (seg) {
        if (seg.type === 'Q') {
          for (var s = 1; s <= QUAD_STEPS; s++) {
            var t = s / QUAD_STEPS;
            var mt = 1 - t;
            var x = mt * mt * seg.x1 + 2 * mt * t * seg.x2 + t * t * seg.x3;
            var y = mt * mt * seg.y1 + 2 * mt * t * seg.y2 + t * t * seg.y3;
            pts.push({ x: x, y: y });
          }
        } else {
          pts.push({ x: seg.x2, y: seg.y2 });
        }
      });
      paths.push(pts);
    });

    latestPaths = { paths: paths, width: tracedata.width, height: tracedata.height };
    drawPreview(latestPaths);
    downloadBtn.disabled = paths.length === 0;
    pathInfo.textContent = paths.length + (paths.length === 1 ? ' shape traced' : ' shapes traced');
  }

  function drawPreview(data) {
    traceCtx.clearRect(0, 0, traceCanvas.width, traceCanvas.height);
    traceCtx.fillStyle = '#fff';
    traceCtx.fillRect(0, 0, traceCanvas.width, traceCanvas.height);
    traceCtx.fillStyle = '#000';
    traceCtx.beginPath();
    data.paths.forEach(function (pts) {
      if (pts.length < 2) return;
      traceCtx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) traceCtx.lineTo(pts[i].x, pts[i].y);
      traceCtx.closePath();
    });
    traceCtx.fill('evenodd');
  }

  function updateOutputSize() {
    if (!latestAspect()) { outHeightEl.textContent = ''; return; }
    var w = parseFloat(outWidthEl.value) || 0;
    var h = w * latestAspect();
    outHeightEl.textContent = 'height ' + h.toFixed(2) + ' ' + unitEl.value;
  }

  function latestAspect() {
    if (!workW || !workH) return 0;
    return workH / workW;
  }

  function updateDownloadLabel() {
    downloadBtn.textContent = 'Download ' + formatEl.value.toUpperCase();
  }

  function exportFile() {
    if (!latestPaths || !latestPaths.paths.length) return;
    var base = fileName.textContent.replace(/\.[^.]+$/, '') || 'trace';
    if (formatEl.value === 'svg') {
      downloadBlob(buildSVG(), base + '.svg');
    } else {
      downloadBlob(buildDXF(), base + '.dxf');
    }
  }

  function buildDXF() {
    var outWidth = parseFloat(outWidthEl.value) || latestPaths.width;
    var scale = outWidth / latestPaths.width;
    var h = latestPaths.height;

    var lines = [];
    lines.push('0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC');
    lines.push('0', 'SECTION', '2', 'TABLES',
      '0', 'TABLE', '2', 'LAYER', '70', '1',
      '0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS',
      '0', 'ENDTAB', '0', 'ENDSEC');
    lines.push('0', 'SECTION', '2', 'ENTITIES');

    latestPaths.paths.forEach(function (pts) {
      if (pts.length < 2) return;
      lines.push('0', 'LWPOLYLINE', '8', '0', '90', String(pts.length), '70', '1', '43', '0');
      pts.forEach(function (p) {
        var x = p.x * scale;
        var y = (h - p.y) * scale; // flip Y: image space is top-down, DXF is bottom-up
        lines.push('10', x.toFixed(4), '20', y.toFixed(4));
      });
    });

    lines.push('0', 'ENDSEC', '0', 'EOF');

    return new Blob([lines.join('\n') + '\n'], { type: 'application/dxf' });
  }

  function buildSVG() {
    var outWidth = parseFloat(outWidthEl.value) || latestPaths.width;
    var scale = outWidth / latestPaths.width;
    var h = (latestPaths.height * scale).toFixed(4);
    var w = outWidth.toFixed(4);
    var unit = unitEl.value;

    var d = latestPaths.paths.map(function (pts) {
      if (pts.length < 2) return '';
      var cmd = 'M ' + (pts[0].x * scale).toFixed(4) + ' ' + (pts[0].y * scale).toFixed(4) + ' ';
      for (var i = 1; i < pts.length; i++) {
        cmd += 'L ' + (pts[i].x * scale).toFixed(4) + ' ' + (pts[i].y * scale).toFixed(4) + ' ';
      }
      return cmd + 'Z';
    }).join(' ');

    var svg = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + unit + '" height="' + h + unit +
      '" viewBox="0 0 ' + w + ' ' + h + '">\n' +
      '  <path d="' + d + '" fill="#000000" fill-rule="evenodd" stroke="none" />\n' +
      '</svg>\n';

    return new Blob([svg], { type: 'image/svg+xml' });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
})();
