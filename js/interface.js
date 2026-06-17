// --- App Configuration & Configuration Constants ---
const DEFAULT_DURATIONS = ['1s', '5s', '15s', '30s', '1m', '2m', '5m', '8m', '10m', '20m', '30m', '1h', '2h'];
let durationSecondsMap = []; 
let zipArrayBuffer = null;
let chartInstance = null;
let heatmapChartInstance = null;

// --- DOM References ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileNameDisplay = document.getElementById('fileName');
const durationInput = document.getElementById('durationInput');
const tagContainer = document.getElementById('tagContainer');
const computeBtn = document.getElementById('computeBtn');
const statusDiv = document.getElementById('status');

// --- Duration Management Engines ---
function parseDuration(str) {
    const match = str.trim().toLowerCase().match(/^(\d+)\s*([smh])$/);
    if (!match) return null;
    
    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    if (unit === 's') return { seconds: value, label: `${value}s` };
    if (unit === 'm') return { seconds: value * 60, label: `${value}m` };
    if (unit === 'h') return { seconds: value * 3600, label: `${value}h` };
    return null;
}

function renderTags() {
    tagContainer.innerHTML = '';
    durationSecondsMap.sort((a, b) => a.seconds - b.seconds);
    
    durationSecondsMap.forEach((item, index) => {
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.innerHTML = `${item.label} <span class="remove-btn" data-index="${index}">&times;</span>`;
        tagContainer.appendChild(tag);
    });
}

tagContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-btn')) {
        const index = parseInt(e.target.getAttribute('data-index'), 10);
        durationSecondsMap.splice(index, 1);
        renderTags();
    }
});

durationInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && durationInput.value) {
        e.preventDefault();
        const parsed = parseDuration(durationInput.value);
        if (parsed && !durationSecondsMap.some(d => d.seconds === parsed.seconds)) {
            durationSecondsMap.push(parsed);
            renderTags();
            durationInput.value = '';
        } else if (!parsed) {
            alert("Format mismatch! Use configurations mirroring '30s', '5m', or '2h'.");
        }
    }
});

// --- Upload Handler Events ---
dropZone.addEventListener('click', () => {
    statusDiv.textContent = "Opening file explorer...";
    fileInput.click();
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        handleFileSelection(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileSelection(e.target.files[0]);
    }
});

let unzippedFiles = null;

function handleFileSelection(file) {
    if (!file.name.endsWith('.zip')) {
        alert("Please provide a valid compressed archive (.zip)");
        computeBtn.disabled = true;
        return;
    }
    fileNameDisplay.textContent = `Target Package: ${file.name}`;
    statusDiv.textContent = "Scanning compressed binary blocks...";
    
    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            zipArrayBuffer = new Uint8Array(evt.target.result);
            // We unzip here to validate contents and store them for computation
            unzippedFiles = fflate.unzipSync(zipArrayBuffer);
            const fitFiles = Object.keys(unzippedFiles).filter(name => name.toLowerCase().endsWith('.fit'));
            
            if (fitFiles.length === 0) {
                statusDiv.textContent = "Validation Failed: No .fit files found in the archive.";
                computeBtn.disabled = true;
                unzippedFiles = null;
                return;
            }
            
            computeBtn.disabled = false;
            statusDiv.textContent = `Found ${fitFiles.length} .fit file(s). Ready to compute.`;
        } catch (err) {
            console.error(err);
            statusDiv.textContent = "Error reading archive structure.";
            computeBtn.disabled = true;
            unzippedFiles = null;
        }
    };
    reader.readAsArrayBuffer(file);
}

// --- Orchestration Logic ---
computeBtn.addEventListener('click', async () => {
    if (!unzippedFiles) return;
    computeBtn.disabled = true;
    statusDiv.textContent = "Extracting compressed context files...";

    try {
        const fitFiles = Object.keys(unzippedFiles).filter(name => name.toLowerCase().endsWith('.fit'));
        
        const curveDataStore = Array.from({ length: durationSecondsMap.length }, () => []);
        const allRides = []; 
        let filesProcessed = 0;
        let totalPowerDataFound = 0;

        for (const filename of fitFiles) {
            statusDiv.textContent = `Evaluating file structure [${filesProcessed + 1}/${fitFiles.length}]: ${filename}...`;
            await new Promise(resolve => setTimeout(resolve, 5));

            const powerData = parseFitPowerStream(unzippedFiles[filename]);
            
            if (powerData.length > 0) {
                totalPowerDataFound += powerData.length;
                const rideCurve = calculatePowerCurve(powerData, durationSecondsMap);
                
                rideCurve.forEach((val, idx) => {
                    if (val > 0) curveDataStore[idx].push(val);
                });
                
                allRides.push(rideCurve.map(v => v > 0 ? v : null));
            }
            filesProcessed++;
        }

        if (totalPowerDataFound === 0) {
            statusDiv.textContent = `Analysis complete across ${filesProcessed} segments, but no power metrics were identified.`;
            const emptyResults = { p50: [], p90: [], p100: [] };
            renderChart(emptyResults);
            renderTable(emptyResults);
        } else {
            statusDiv.textContent = `Analysis complete! Rendering distributions...`;
            
            const results = {
                p50: curveDataStore.map(vals => getPercentile(vals, 0.5)),
                p90: curveDataStore.map(vals => getPercentile(vals, 0.9)),
                p100: curveDataStore.map(vals => getPercentile(vals, 1.0))
            };
            
            renderChart(results);
            renderHeatmapChart(allRides);
            renderTable(results);
        }

    } catch (err) {
        console.error(err);
        statusDiv.textContent = "Process stalled. Review debugger runtime trace.";
    } finally {
        computeBtn.disabled = false;
    }
});

// --- Visualization Engines ---
function renderChart(percentiles) {
    const labels = durationSecondsMap.map(d => d.label);
    if (chartInstance) chartInstance.destroy();

    const ctx = document.getElementById('powerChart').getContext('2d');
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: '100th Percentile (Absolute Peak)',
                    data: percentiles.p100.map(v => Math.round(v)),
                    borderColor: '#8a2be2',
                    backgroundColor: 'transparent',
                    borderWidth: 3,
                    tension: 0.1,
                    pointRadius: 0,
                    pointHitRadius: 10,
                    spanGaps: true
                },
                {
                    label: '90th Percentile (On a Good Day)',
                    data: percentiles.p90.map(v => Math.round(v)),
                    borderColor: '#ffa500',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    tension: 0.1,
                    pointRadius: 0,
                    pointHitRadius: 10,
                    spanGaps: true
                },
                {
                    label: '50th Percentile Median (On Average)',
                    data: percentiles.p50.map(v => Math.round(v)),
                    borderColor: '#28a745',
                    backgroundColor: 'rgba(40, 167, 69, 0.05)',
                    borderWidth: 2,
                    tension: 0.1,
                    fill: true,
                    pointRadius: 0,
                    pointHitRadius: 10,
                    spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: { label: (context) => ` ${context.dataset.label}: ${context.parsed.y} W` }
                }
            },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: 'Power (Watts)', font: { weight: 'bold' } } },
                x: { title: { display: true, text: 'Interval Duration', font: { weight: 'bold' } } }
            }
        }
    });
}

function renderHeatmapChart(allRides) {
    const labels = durationSecondsMap.map(d => d.label);
    if (heatmapChartInstance) heatmapChartInstance.destroy();

    const datasets = [];
    const colorScale = (val) => `rgba(255, 69, 0, ${Math.min(val * 0.2, 1)})`;

    durationSecondsMap.forEach((_, durIdx) => {
        const powers = allRides.map(r => r[durIdx]).filter(p => p !== null && p > 0);
        if (powers.length === 0) return;

        const min = Math.min(...powers);
        const max = Math.max(...powers);
        const binCount = 15;
        const binSize = (max - min) / binCount || 1;
        const bins = Array(binCount).fill(0);

        powers.forEach(p => {
            const b = Math.min(Math.floor((p - min) / binSize), binCount - 1);
            bins[b]++;
        });

        const bubbleData = bins.map((count, binIdx) => ({
            x: durIdx,
            y: Math.round(min + (binIdx * binSize) + (binSize / 2)),
            r: Math.sqrt(count) * 4,
            v: count
        })).filter(b => b.v > 0);

        datasets.push({
            label: labels[durIdx],
            data: bubbleData,
            backgroundColor: (ctx) => colorScale(ctx.raw ? ctx.raw.v : 0),
            borderColor: 'transparent'
        });
    });

    const ctx = document.getElementById('heatmapChart').getContext('2d');
    heatmapChartInstance = new Chart(ctx, {
        type: 'bubble',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { label: (ctx) => ` ${ctx.raw.v} rides at ~${ctx.raw.y}W` }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    offset: true,
                    ticks: { stepSize: 1, callback: (v) => labels[v] || '' },
                    title: { display: true, text: 'Duration' }
                },
                y: { beginAtZero: true, title: { display: true, text: 'Power (W)' } }
            }
        }
    });
}

function renderTable(percentiles) {
    const container = document.getElementById('tableContainer');
    if (percentiles.p100.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = `<table><thead><tr><th>Duration</th><th>On Average (50th)</th><th>On a Good Day (90th)</th><th>Absolute Peak (100th)</th></tr></thead><tbody>`;
    durationSecondsMap.forEach((duration, idx) => {
        html += `<tr><td>${duration.label}</td><td class="val-50">${Math.round(percentiles.p50[idx] || 0)} W</td><td class="val-90">${Math.round(percentiles.p90[idx] || 0)} W</td><td class="val-100">${Math.round(percentiles.p100[idx] || 0)} W</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

// --- Bootstrap ---
DEFAULT_DURATIONS.forEach(d => durationSecondsMap.push(parseDuration(d)));
renderTags();

function showTab(tabId) {
    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const clickedBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => btn.textContent.toLowerCase() === tabId);
    if (clickedBtn) clickedBtn.classList.add('active');

    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabId + 'Tab').classList.add('active');
}

window.showTab = showTab;