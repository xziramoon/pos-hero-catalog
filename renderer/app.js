        // ================================================================
        // [FIX #1] ลบสคริปต์ซ้ำซ้อน — รวมโค้ดทุกอย่างไว้ใน script เดียว
        // ================================================================

        // ==========================================
        // ส่วนที่ 1: Global Event Listeners (ไม่เปลี่ยนแปลง)
        // ==========================================
        document.addEventListener('wheel', function(event) {
            if (document.activeElement.type === 'number') document.activeElement.blur();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                const activeElem = document.activeElement;
                if (activeElem && activeElem.classList.contains('num-input')) {
                    e.preventDefault();
                    const currentModal = activeElem.closest('.modal-content');
                    if (currentModal) {
                        const inputs = Array.from(currentModal.querySelectorAll('.num-input'));
                        const currentIndex = inputs.indexOf(activeElem);
                        if (currentIndex > -1 && currentIndex < inputs.length - 1) inputs[currentIndex + 1].focus();
                        else activeElem.blur();
                    }
                }
            }
        });

        // Escape key closes all modals
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
        });

        // ==========================================
        // ส่วนที่ 2: ตัวแปร Global และ localStorage
        // ==========================================
        let records = [];
        let currentFilter = 'all';
        try { let rawData = JSON.parse(localStorage.getItem('posUltimateRecords')); records = Array.isArray(rawData) ? rawData : []; } catch(e) { records = []; }
        let headerData = {};
        try { headerData = JSON.parse(localStorage.getItem('posUltimateHeader')) || {}; } catch(e) { headerData = {}; }

        document.getElementById('headDate').innerText = new Date().toLocaleDateString('th-TH');
        document.getElementById('headPos').value = headerData.pos || '';
        document.getElementById('headCashier').value = headerData.cashier || '';

        // ✨ v5: ตรวจจับข้อมูลค้างจากวันก่อน (New Day Guard)
        (function newDayGuard() {
            const todayKey = new Date().toLocaleDateString('th-TH');
            const savedDate = localStorage.getItem('posUltimateDate') || '';
            if (records.length > 0 && savedDate && savedDate !== todayKey) {
                if (confirm('⚠️ พบข้อมูลของวันก่อน (' + savedDate + ') ค้างอยู่ ' + records.length + ' รายการ\n\nกด OK = สำรองเป็นไฟล์ + เริ่มวันใหม่\nกด Cancel = ใช้ข้อมูลเดิมต่อ')) {
                    backupData(savedDate);
                    records = [];
                    localStorage.removeItem('posUltimateRecords');
                }
            }
            localStorage.setItem('posUltimateDate', todayKey);
        })();

        function saveHeader() { localStorage.setItem('posUltimateHeader', JSON.stringify({ pos: document.getElementById('headPos').value, cashier: document.getElementById('headCashier').value })); }
        function escapeHTML(str) { return (str||'-').toString().replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)); }

        // ==========================================
        // ส่วนที่ 3: handleTypeChange — [FIX] รวมจาก Override Patch
        // [FIX #2] ช่องกรอกชื่อไม่หายเมื่อเลือก "โอน" + โฟกัสถูกช่อง
        // ==========================================
        function handleTypeChange() {
            const type = document.querySelector('input[name="payType"]:checked').value;
            const nameInput = document.getElementById('inputName');
            const amtInput = document.getElementById('inputAmount');

            // [FIX] บังคับให้ช่องกรอกชื่อแสดงผลเสมอ (เดิมโค้ดเก่าซ่อนตอนเลือก "โอน")
            nameInput.style.display = 'block';

            if (type === 'transfer') {
                nameInput.value = '';
                nameInput.placeholder = "ชื่อผู้โอน / รายการ...";
                amtInput.placeholder = "ยอดโอน"; // [ข้อ 17] ช่องนี้แคบ (flex:1) ข้อความยาวเดิม "ยอดเงินโอน..." ถูกตัด
            } else if (type === 'thaiplus') {
                nameInput.value = '';
                nameInput.placeholder = "ชื่อลูกค้า (ถ้ามี)...";
                amtInput.placeholder = "ยอดสแกน";
            } else {
                nameInput.value = '';
                nameInput.placeholder = "ระบุรายการ...";
                amtInput.placeholder = "0";
            }

            // [FIX] โฟกัสไปที่ช่องกรอกชื่อเสมอเพื่อความลื่นไหล
            nameInput.focus();
        }

        document.getElementById('inputAmount').addEventListener("keypress", function(e) { if (e.key === "Enter" && !e.target.classList.contains('num-input')) saveRecord(); });
        document.getElementById('inputName').addEventListener("keypress", function(e) { if (e.key === "Enter" && this.value.trim() !== "") document.getElementById('inputAmount').focus(); });

        // ==========================================
        // ส่วนที่ 4: saveRecord — [FIX] รวมจาก Override Patch
        // [FIX #3] ไม่แทรก Tag "(ไทยพลัส)" ซ้ำในชื่อ + ชื่อสั้นกระชับ
        // ==========================================
        function saveRecord() {
            const amtIn = document.getElementById('inputAmount');
            const nameIn = document.getElementById('inputName');
            const type = document.querySelector('input[name="payType"]:checked').value;
            const amount = parseFloat(amtIn.value);
            let rawName = nameIn.value.trim();

            if (isNaN(amount) || amount <= 0) return;

            // [FIX] ตั้งชื่อรายการให้สั้นกระชับ ไม่ต่อท้ายประเภท
            let finalName = rawName !== "" ? rawName : (type === 'transfer' ? "ลูกค้าโอนเงิน" : "ลูกค้าทั่วไป");

            records.push({
                time: new Date().toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'}),
                type: type,
                name: finalName,
                amount: amount,
                isEdited: false
            });

            localStorage.setItem('posUltimateDate', new Date().toLocaleDateString('th-TH'));
            localStorage.setItem('posUltimateRecords', JSON.stringify(records));
            renderTable();
            if (typeof celebrateTransaction === 'function') celebrateTransaction(amount, { moneyIn: false });

            amtIn.value = '';
            nameIn.value = '';
            nameIn.focus();
        }

        // ==========================================
        // ส่วนที่ 5: Undo / Delete / Edit
        // ==========================================
        let undoStack = [];
        let undoTimer = null;
        function deleteRecord(index) {
            const removed = records.splice(index, 1)[0];
            if (!removed) return;
            undoStack.push({ record: removed, index: index });
            localStorage.setItem('posUltimateRecords', JSON.stringify(records));
            renderTable();
            document.getElementById('undoToastMsg').innerText = 'ลบ "' + (removed.name || '-') + '" ' + (parseFloat(removed.amount)||0).toLocaleString('en-US') + ' ฿ แล้ว';
            document.getElementById('undoToast').classList.add('show');
            clearTimeout(undoTimer);
            undoTimer = setTimeout(hideUndoToast, 6000);
        }
        function hideUndoToast() { document.getElementById('undoToast').classList.remove('show'); undoStack = []; }
        function undoDelete() {
            const last = undoStack.pop();
            if (last) {
                records.splice(Math.min(last.index, records.length), 0, last.record);
                localStorage.setItem('posUltimateRecords', JSON.stringify(records));
                renderTable();
            }
            clearTimeout(undoTimer);
            hideUndoToast();
        }

        // ==========================================
        // [ข้อ 1 feedback แอ๋ม] Electron ไม่รองรับ prompt() (ขึ้น error เงียบๆ แล้วไม่มีอะไรเกิดขึ้น
        // เลย) — เดิม editAmount/editName เรียก prompt() ตรงๆ ทำให้แก้ชื่อ/ยอดในตารางไม่ได้เลย
        // ต้องลบรายการแล้วพิมพ์ใหม่แทน → เปลี่ยนมาใช้ modal เล็กๆ ของแอปเอง (#editModal ใน
        // index.html ใช้ class modal-overlay/modal-content เดิมที่มีอยู่แล้ว) confirm()/alert() ยัง
        // ใช้ได้ปกติใน Electron เลยไม่ต้องแตะจุดอื่น (ตรวจแล้วในไฟล์นี้มีแค่ 2 จุดที่เรียก prompt())
        // ==========================================
        var _editModalTarget = null; // { index, field: 'name' | 'amount' }

        function editAmount(index) {
            const r = records[index];
            if (!r) return;
            _editModalTarget = { index: index, field: 'amount' };
            document.getElementById('editModalTitle').textContent = '✏️ แก้ไขยอดเงิน';
            document.getElementById('editModalLabel').textContent = 'ยอดเงินของ "' + (r.name || '-') + '"';
            var input = document.getElementById('editModalInput');
            input.type = 'number';
            input.value = r.amount;
            document.getElementById('editModal').style.display = 'flex';
            setTimeout(function() { input.focus(); input.select(); }, 50);
        }

        function editName(index) {
            const r = records[index];
            if (!r) return;
            _editModalTarget = { index: index, field: 'name' };
            document.getElementById('editModalTitle').textContent = '✏️ แก้ไขชื่อรายการ';
            document.getElementById('editModalLabel').textContent = 'ชื่อรายการ';
            var input = document.getElementById('editModalInput');
            input.type = 'text';
            input.value = r.name || '-';
            document.getElementById('editModal').style.display = 'flex';
            setTimeout(function() { input.focus(); input.select(); }, 50);
        }

        function closeEditModal() {
            document.getElementById('editModal').style.display = 'none';
            _editModalTarget = null;
        }

        function confirmEditModal() {
            if (!_editModalTarget) return;
            const r = records[_editModalTarget.index];
            if (!r) { closeEditModal(); return; }
            const raw = document.getElementById('editModalInput').value;
            if (_editModalTarget.field === 'amount') {
                const val = parseFloat(raw);
                if (isNaN(val) || val <= 0) { alert('⚠️ ยอดเงินไม่ถูกต้อง'); return; }
                r.amount = val;
            } else {
                let newName = raw.trim();
                if (newName === '') newName = '-';
                r.name = newName;
            }
            r.isEdited = true;
            localStorage.setItem('posUltimateRecords', JSON.stringify(records));
            renderTable();
            closeEditModal();
        }

        function resetAll() {
            if (!confirm('⚠️ ล้างข้อมูลเริ่มกะใหม่?')) return;
            if (records.length > 0 && confirm('💾 ต้องการสำรองข้อมูลเป็นไฟล์ก่อนล้างหรือไม่?')) backupData();
            records = [];
            localStorage.removeItem('posUltimateRecords');
            localStorage.removeItem('posUltimateRecon');
            hideUndoToast();
            renderTable();
        }

        // ==========================================
        // ส่วนที่ 6: สำรอง / กู้คืนข้อมูล
        // ==========================================
        function backupData(labelDate) {
            if (records.length === 0) { alert('⚠️ ไม่มีข้อมูลสำหรับสำรอง'); return; }
            const dateLabel = labelDate || document.getElementById('headDate').innerText;
            const payload = {
                app: 'POS-Reconciliations',
                date: dateLabel,
                exportedAt: new Date().toISOString(),
                header: { pos: document.getElementById('headPos').value, cashier: document.getElementById('headCashier').value },
                records: records
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'POS_Backup_' + dateLabel.replace(/\//g, '-') + '_' + new Date().toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'}).replace(':','') + '.json';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        }
        function restoreData(ev) {
            const file = ev.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const data = JSON.parse(e.target.result);
                    const recs = Array.isArray(data) ? data : data.records;
                    if (!Array.isArray(recs)) throw new Error('invalid');
                    if (!confirm('📂 พบ ' + recs.length + ' รายการในไฟล์สำรอง\nต้องการแทนที่ข้อมูลปัจจุบัน (' + records.length + ' รายการ) หรือไม่?')) { ev.target.value = ''; return; }
                    records = recs;
                    localStorage.setItem('posUltimateRecords', JSON.stringify(records));
                    if (data.header) {
                        if (data.header.pos) document.getElementById('headPos').value = data.header.pos;
                        if (data.header.cashier) document.getElementById('headCashier').value = data.header.cashier;
                        saveHeader();
                    }
                    renderTable();
                    alert('✅ กู้คืนข้อมูลสำเร็จ ' + records.length + ' รายการ');
                } catch (err) { alert('❌ ไฟล์สำรองไม่ถูกต้อง'); }
                ev.target.value = '';
            };
            reader.readAsText(file);
        }

        // ==========================================
        // ส่วนที่ 7: Filter + Render Table
        // ==========================================
        function setFilter(type) {
            currentFilter = type;
            document.querySelectorAll('.filter-tab').forEach(el => el.classList.remove('active'));
            document.getElementById('tab-' + type).classList.add('active');
            renderTable();
        }

        function renderTable() {
            const tbody = document.getElementById('tableBody');
            let t=0, w=0, tp=0, e=0, cT=0, cW=0, cP=0, cE=0;

            records.forEach(r => {
                const amt = Math.round((parseFloat(r.amount) || 0) * 100);
                if (r.type === 'transfer') { t += amt; cT++; }
                else if (r.type === 'welfare') { w += amt; cW++; }
                else if (r.type === 'thaiplus') { tp += amt; cP++; }
                else { e += amt; cE++; }
            });

            tbody.innerHTML = records.map((r, i) => { return {...r, originalIndex: i}; })
                .filter(r => currentFilter === 'all' || r.type === currentFilter)
                .map((r) => {
                    let badge = r.type==='transfer' ? '<span class="badge bg-tr">โอน</span>' : r.type==='welfare' ? '<span class="badge bg-wel">บัตร</span>' : r.type==='thaiplus' ? '<span class="badge bg-thaiplus">ไทยพลัส</span>' : '<span class="badge bg-exp">จ่าย</span>';
                    let cls = r.type==='transfer' ? 'row-transfer' : r.type==='welfare' ? 'row-welfare' : r.type==='thaiplus' ? 'row-thaiplus' : 'row-expense';
                    let editedMark = r.isEdited ? '<span class="edited-mark">✎</span>' : '';
                    // ✓✓ = รายการเดียวกันถูกยืนยันจากหลายช่องทาง (Firebase / วงเน็ต / Pushbullet) — ดูส่วนที่ 12
                    if (r.channels && r.channels.length > 1 && typeof CHANNEL_NAMES !== 'undefined' && CHANNEL_NAMES) {
                        editedMark += '<span class="multi-mark no-print" title="ยืนยันจาก ' + escapeHTML(r.channels.map(c => CHANNEL_NAMES[c] || c).join(' + ')) + '">✓✓</span>';
                    }
                    // [ข้อ 6] เวลาที่แสดงเป็นเวลาแจ้งเตือนเข้าจริงอยู่แล้ว (ดู pbInject) — ติดป้ายเล็กๆ
                    // บอกว่ารายการนี้มากู้คืนทีหลัง เผื่อแคชเชียร์สงสัยว่าทำไมเวลาไม่เรียงตามลำดับที่เห็น
                    let timeCell = escapeHTML(r.time) + (r.backfilled ? ' <span class="backfill-mark no-print" title="กู้คืนภายหลัง — เวลานี้คือเวลาที่แจ้งเตือนเข้าจริง ไม่ใช่เวลาที่กู้คืนได้">↻กู้คืน</span>' : '');
                    return '<tr class="' + cls + '"><td style="text-align:center; color:#ccc;">' + (r.originalIndex+1) + '</td><td style="font-size:12px; color:#666;">' + timeCell + '</td><td style="text-align:center;">' + badge + '</td><td class="name-editable" onclick="editName(' + r.originalIndex + ')" title="แตะเพื่อแก้ไขชื่อ">' + escapeHTML(r.name) + editedMark + '</td><td class="amt-editable" style="text-align:right; font-weight:bold;" onclick="editAmount(' + r.originalIndex + ')" title="แตะเพื่อแก้ไขยอด">' + (parseFloat(r.amount)||0).toLocaleString('en-US') + '</td><td class="no-print" style="text-align:center;"><span class="action-btn" style="color:red;" onclick="deleteRecord(' + r.originalIndex + ')">×</span></td></tr>';
                }).join('');

            document.getElementById('sumTransfer').innerText = (t/100).toLocaleString('en-US');
            document.getElementById('sumWelfare').innerText = (w/100).toLocaleString('en-US');
            document.getElementById('sumThaiPlus').innerText = (tp/100).toLocaleString('en-US');
            document.getElementById('sumExpense').innerText = (e/100).toLocaleString('en-US');
            document.getElementById('sumNet').innerText = ((t+w+tp)/100).toLocaleString('en-US');
            updateTabCounts(cT, cW, cP, cE);
            updateMiniWidget(records, (t+w+tp)/100);
        }

        // เติมข้อมูลให้วิดเจ็ตจิ๋ว (โหมดย่อ) ไม่ว่าจะกำลังโชว์อยู่หรือไม่ก็ตาม
        // เพื่อให้พร้อมข้อมูลล่าสุดทันทีที่ผู้ใช้กดย่อหน้าจอ
        function updateMiniWidget(recs, netTotal) {
            var miniSum = document.getElementById('miniSumNet');
            var miniLast = document.getElementById('miniLastTx');
            if (!miniSum || !miniLast) return;
            miniSum.textContent = netTotal.toLocaleString('en-US');
            if (recs && recs.length > 0) {
                var last = recs[recs.length - 1];
                var amt = (parseFloat(last.amount) || 0).toLocaleString('en-US');
                miniLast.textContent = '+' + amt + ' ฿ ' + escapeHTML(last.name || '-');
            } else {
                miniLast.textContent = '— ยังไม่มีรายการ —';
            }
        }

        function setTabLabel(id, text, count) {
            document.getElementById(id).innerHTML = count > 0 ? text + '<span class="tab-count">' + count + '</span>' : text;
        }
        function updateTabCounts(cT, cW, cP, cE) {
            setTabLabel('tab-all', 'ทั้งหมด', cT + cW + cP + cE);
            setTabLabel('tab-transfer', 'โอน', cT);
            setTabLabel('tab-welfare', 'บัตรรัฐ', cW);
            setTabLabel('tab-thaiplus', 'ไทยพลัส', cP);
            setTabLabel('tab-expense', 'ค่าใช้จ่าย', cE);
        }

        // ==========================================
        // ส่วนที่ 8: นับลิ้นชัก + แลกเงิน + Export
        // ==========================================
        const denoms = [ { val: 1000, label: 'แบงก์ 1000', exLabel: '1000' }, { val: 500, label: 'แบงก์ 500', exLabel: '500' }, { val: 100, label: 'แบงก์ 100', exLabel: '100' }, { val: 50, label: 'แบงก์ 50', exLabel: '50' }, { val: 20, label: 'แบงก์ 20', exLabel: '20' }, { val: 10, label: 'เหรียญ 10', exLabel: 'เหรียญ 10' }, { val: 5, label: 'เหรียญ 5', exLabel: 'เหรียญ 5' }, { val: 2, label: 'เหรียญ 2', exLabel: 'เหรียญ 2' }, { val: 1, label: 'เหรียญ 1', exLabel: 'เหรียญ 1' } ];

        function openManualModal() { document.getElementById('manualModal').style.display = 'flex'; }
        function closeManualModal() { document.getElementById('manualModal').style.display = 'none'; }

        const STARTING_FLOAT = 9700;
        function initDrawerTable() { document.getElementById('drawerTableBody').innerHTML = denoms.map(d => '<tr><td>' + d.label + '</td><td style="text-align:center;"><input type="number" id="dr_qty_' + d.val + '" class="num-input" min="0" oninput="calcDrawer()"></td><td class="val-display" id="dr_val_' + d.val + '">0</td></tr>').join(''); }
        function openDrawerModal() { let totalExpense = 0; records.forEach(r => { if(r.type === 'expense') totalExpense += (parseFloat(r.amount)||0); }); document.getElementById('dsExpense').innerText = '-' + totalExpense.toLocaleString('en-US'); document.getElementById('drawerModal').dataset.expense = totalExpense; document.getElementById('dsCashSales').value = ''; denoms.forEach(d => { document.getElementById('dr_qty_' + d.val).value = ''; document.getElementById('dr_val_' + d.val).innerText = '0'; }); calcDrawer(); document.getElementById('drawerModal').style.display = 'flex'; }
        function closeDrawerModal() { document.getElementById('drawerModal').style.display = 'none'; }

        function calcDrawer() {
            let actualCash = 0;
            denoms.forEach(d => { let qty = parseInt(document.getElementById('dr_qty_' + d.val).value) || 0; let val = qty * d.val; document.getElementById('dr_val_' + d.val).innerText = val.toLocaleString('en-US'); actualCash += val; });
            document.getElementById('dsActual').innerText = actualCash.toLocaleString('en-US');
            let totalExpense = parseFloat(document.getElementById('drawerModal').dataset.expense) || 0;
            let cashSales = parseFloat(document.getElementById('dsCashSales').value) || 0;
            let expectedCash = STARTING_FLOAT + cashSales - totalExpense;
            document.getElementById('dsExpected').innerText = expectedCash.toLocaleString('en-US');
            let diff = actualCash - expectedCash;
            let diffBox = document.getElementById('dsDiffBox');
            let btn = document.getElementById('btnDrSubmit');
            if (actualCash === 0 && cashSales === 0) { diffBox.className = 'ds-diff status-short'; diffBox.innerText = 'รอการนับเงิน...'; btn.disabled = true; }
            else { btn.disabled = false; if (diff === 0) { diffBox.className = 'ds-diff status-ok'; diffBox.innerHTML = '✅ ยอดเงินตรงเป๊ะ (Match)'; } else if (diff > 0) { diffBox.className = 'ds-diff status-over'; diffBox.innerHTML = '🟡 เงินเกิน: +' + diff.toLocaleString('en-US') + ' บาท'; } else { diffBox.className = 'ds-diff status-short'; diffBox.innerHTML = '🔴 เงินขาด: ' + diff.toLocaleString('en-US') + ' บาท'; } }
        }

        function clearPrintClasses() { document.body.classList.remove('printing-drawer', 'printing-exchange', 'print-summary-only', 'printing-recon'); }
        function printMain() { clearPrintClasses(); heroPrint(); }

        function executePrintDrawer() {
            clearPrintClasses();
            const now = new Date();
            document.getElementById('slipDrDate').innerText = document.getElementById('headDate').innerText;
            document.getElementById('slipDrTime').innerText = now.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
            document.getElementById('slipDrCashier').innerText = document.getElementById('headCashier').value || 'ไม่ระบุชื่อ';
            let tbody = '';
            denoms.forEach(d => { let qty = parseInt(document.getElementById('dr_qty_' + d.val).value) || 0; if(qty > 0) tbody += '<tr><td>' + d.label + '</td><td>' + qty + '</td><td>' + (qty * d.val).toLocaleString('en-US') + '</td></tr>'; });
            document.getElementById('slipDrBody').innerHTML = tbody;
            let cashSales = parseFloat(document.getElementById('dsCashSales').value) || 0;
            document.getElementById('slipDrSales').innerText = cashSales.toLocaleString('en-US');
            document.getElementById('slipDrExpense').innerText = document.getElementById('dsExpense').innerText;
            document.getElementById('slipDrExpected').innerText = document.getElementById('dsExpected').innerText;
            document.getElementById('slipDrActual').innerText = document.getElementById('dsActual').innerText;
            document.getElementById('slipDrDiff').innerText = document.getElementById('dsDiffBox').innerText.replace(/[✅🟡🔴]/g, '').trim();
            document.body.classList.add('printing-drawer');
            closeDrawerModal();
            heroPrint();
        }

        function initExchangeTable() { document.getElementById('exchangeTableBody').innerHTML = denoms.filter(d=>d.val<1000).map(d => '<tr><td>' + d.exLabel + '</td><td style="text-align:right;"><input type="number" id="ex_' + d.val + '" class="num-input" style="width: 100px; text-align:right;" placeholder="0" oninput="calcExchange()"></td></tr>').join(''); }
        function openExchangeModal() { denoms.filter(d=>d.val<1000).forEach(d => document.getElementById('ex_' + d.val).value = ''); calcExchange(); document.getElementById('exchangeModal').style.display = 'flex'; }
        function closeExchangeModal() { document.getElementById('exchangeModal').style.display = 'none'; }
        function calcExchange() { let total = 0; denoms.filter(d=>d.val<1000).forEach(d => { total += parseFloat(document.getElementById('ex_' + d.val).value) || 0; }); document.getElementById('exTotalTxt').innerText = total.toLocaleString('en-US'); document.getElementById('btnExSubmit').disabled = (total <= 0); }

        function executePrintExchange() {
            clearPrintClasses();
            const now = new Date();
            document.getElementById('slipExDate').innerText = document.getElementById('headDate').innerText;
            document.getElementById('slipExTime').innerText = now.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
            document.getElementById('slipExCashier').innerText = document.getElementById('headCashier').value || 'ไม่ระบุชื่อ';
            let tbody = ''; let totalAmount = 0;
            denoms.filter(d=>d.val<1000).forEach(d => { let val = parseFloat(document.getElementById('ex_' + d.val).value) || 0; if(val > 0) { tbody += '<tr><td>' + d.exLabel + '</td><td style="text-align:right;">' + val.toLocaleString('en-US') + '</td></tr>'; totalAmount += val; } });
            document.getElementById('slipExBody').innerHTML = tbody;
            document.getElementById('slipExTotalVal').innerText = totalAmount.toLocaleString('en-US');
            document.body.classList.add('printing-exchange');
            closeExchangeModal();
            heroPrint();
        }

        function exportToExcel() {
            if(records.length === 0) { alert('⚠️ ไม่มีข้อมูลสำหรับ Export'); return; }
            let t = 0, w = 0, tp = 0, e = 0;
            records.forEach(r => { let amt = Math.round((parseFloat(r.amount) || 0) * 100); if(r.type === 'transfer') t += amt; else if(r.type === 'welfare') w += amt; else if(r.type === 'thaiplus') tp += amt; else e += amt; });
            let dateStr = document.getElementById('headDate').innerText, cashier = document.getElementById('headCashier').value || 'ไม่ระบุชื่อ';
            let html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"><style>table{border-collapse:collapse;}th{background:#eee;border:1px solid #000;}td{border:1px solid #ccc;padding:5px;}.bg-g{background:#d1fae5;}.bg-b{background:#e0f2fe;}.bg-tp{background:#E4F4EC;}.bg-r{background:#fee2e2;}</style></head><body><h3>รายงานยอดขาย ' + dateStr + ' (แคชเชียร์: ' + escapeHTML(cashier) + ')</h3><table><thead><tr><th>เวลา</th><th>ประเภท</th><th>รายการ</th><th>ยอดเงิน</th></tr></thead><tbody>';
            records.forEach(rec => { let bg = rec.type === 'transfer' ? 'bg-g' : (rec.type === 'welfare' ? 'bg-b' : (rec.type === 'thaiplus' ? 'bg-tp' : 'bg-r')); let typeText = rec.type === 'thaiplus' ? 'ไทยพลัส' : rec.type; html += '<tr><td class="' + bg + '">' + rec.time + '</td><td class="' + bg + '">' + typeText + '</td><td class="' + bg + '">' + escapeHTML(rec.name) + '</td><td class="' + bg + '" style="text-align:right;">' + (parseFloat(rec.amount) || 0).toLocaleString('en-US') + '</td></tr>'; });
            html += '</tbody></table><br><table border="1"><tr><td>โอน:</td><td>' + (t/100).toLocaleString('en-US') + '</td></tr><tr><td>บัตร:</td><td>' + (w/100).toLocaleString('en-US') + '</td></tr><tr><td>ไทยพลัส:</td><td>' + (tp/100).toLocaleString('en-US') + '</td></tr><tr><td>ค่าใช้จ่าย:</td><td>' + (e/100).toLocaleString('en-US') + '</td></tr><tr><td>สุทธิ:</td><td>' + ((t+w+tp)/100).toLocaleString('en-US') + '</td></tr></table></body></html>';
            const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'POS_Report_' + dateStr.replace(/\//g, '-') + '.xls';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        }

        // ==========================================
        // ส่วนที่ 9: กระทบยอดเงินดิจิทัล (Reconciliation)
        // ==========================================
        // [FIX #12] ค่าที่กรอกในช่องกระทบยอด (รวมถึงยอดที่มือถือเติมให้อัตโนมัติผ่าน relay)
        // ไม่เคยถูกบันทึกไว้ที่ไหนเลย พอปิด/เปิด Modal ใหม่ค่าที่เคยเติมไว้เลยหายหมด
        // → บันทึกลง localStorage ทุกครั้งที่มีการคำนวณ แล้วโหลดกลับมาตอนเปิด Modal (เฉพาะวันเดียวกัน)
        function saveReconInputs() {
            localStorage.setItem('posUltimateRecon', JSON.stringify({
                date: new Date().toLocaleDateString('th-TH'),
                pos2: document.getElementById('reconPos2').value,
                bank1: document.getElementById('reconBank1').value,
                bank2: document.getElementById('reconBank2').value,
                paotang: document.getElementById('reconPaotang').value
            }));
        }
        function loadReconInputs() {
            try {
                const data = JSON.parse(localStorage.getItem('posUltimateRecon'));
                if (data && data.date === new Date().toLocaleDateString('th-TH')) return data;
            } catch(e) {}
            return null;
        }

        function openReconModal() {
            let t = 0;
            records.forEach(r => { if(r.type === 'transfer') { t += Math.round((parseFloat(r.amount) || 0) * 100); } });
            let currentPosTransfer = t / 100;
            document.getElementById('reconPos1Transfer').value = currentPosTransfer > 0 ? currentPosTransfer : '';
            const saved = loadReconInputs();
            document.getElementById('reconPos2').value = saved ? saved.pos2 : '';
            document.getElementById('reconBank1').value = saved ? saved.bank1 : '';
            document.getElementById('reconBank2').value = saved ? saved.bank2 : '';
            document.getElementById('reconPaotang').value = saved ? saved.paotang : '';
            calcRecon();
            document.getElementById('reconModal').style.display = 'flex';
        }
        // ⚙️ ตั้งค่า แยกเป็นหน้าต่างของตัวเอง (ปุ่มที่แผงด้านล่าง) — การเติมยอดเข้าช่องกระทบยอดอัตโนมัติ
        // ยังทำเฉพาะตอนหน้าต่าง 🔍 ตรวจเช็คเงินโอน (#reconModal) เปิดอยู่เหมือนเดิม
        function openSettingsModal() {
            var m = document.getElementById('settingsModal');
            m.style.display = 'flex';
            m.scrollTop = 0;
        }
        function closeSettingsModal() { document.getElementById('settingsModal').style.display = 'none'; }
        function closeReconModal() { document.getElementById('reconModal').style.display = 'none'; }

        function calcRecon() {
            saveReconInputs();
            let p1 = parseFloat(document.getElementById('reconPos1Transfer').value) || 0;
            let p2 = parseFloat(document.getElementById('reconPos2').value) || 0;
            let totalPos = p1 + p2;
            document.getElementById('reconPosTotal').innerText = totalPos.toLocaleString('en-US');
            let b1 = parseFloat(document.getElementById('reconBank1').value) || 0;
            let b2 = parseFloat(document.getElementById('reconBank2').value) || 0;
            let pt = parseFloat(document.getElementById('reconPaotang').value) || 0;
            let totalBank = b1 + b2 + pt;
            document.getElementById('reconBankTotal').innerText = totalBank.toLocaleString('en-US');
            let diff = totalBank - totalPos;
            let diffBox = document.getElementById('reconDiffBox');
            let btn = document.getElementById('btnReconSubmit');
            if (totalPos === 0 && totalBank === 0) { diffBox.className = 'ds-diff status-short'; diffBox.innerText = 'รอป้อนข้อมูล...'; btn.disabled = true; }
            else { btn.disabled = false; if (diff === 0) { diffBox.className = 'ds-diff status-ok'; diffBox.innerHTML = '✅ ยอดเงินเข้าบัญชี <b>ตรงเป๊ะ</b> (Match)'; } else if (diff > 0) { diffBox.className = 'ds-diff status-over'; diffBox.innerHTML = '🟡 เงินเข้าเกิน: เข้าบัญชีมากกว่า POS <b>+' + diff.toLocaleString('en-US') + '</b> บาท'; } else { diffBox.className = 'ds-diff status-short'; diffBox.innerHTML = '🔴 เงินเข้าขาด: เข้าบัญชีน้อยกว่า POS <b>' + diff.toLocaleString('en-US') + '</b> บาท'; } }
        }

        function executePrintRecon() {
            clearPrintClasses();
            const now = new Date();
            document.getElementById('slipRcDate').innerText = document.getElementById('headDate').innerText;
            document.getElementById('slipRcTime').innerText = now.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
            document.getElementById('slipRcCashier').innerText = document.getElementById('headCashier').value || 'ไม่ระบุชื่อ';
            document.getElementById('slipRcPos1Transfer').innerText = (parseFloat(document.getElementById('reconPos1Transfer').value) || 0).toLocaleString('en-US');
            document.getElementById('slipRcPos2').innerText = (parseFloat(document.getElementById('reconPos2').value) || 0).toLocaleString('en-US');
            document.getElementById('slipRcPosTotal').innerText = document.getElementById('reconPosTotal').innerText;
            document.getElementById('slipRcBank1').innerText = (parseFloat(document.getElementById('reconBank1').value) || 0).toLocaleString('en-US');
            document.getElementById('slipRcBank2').innerText = (parseFloat(document.getElementById('reconBank2').value) || 0).toLocaleString('en-US');
            document.getElementById('slipRcPaotang').innerText = (parseFloat(document.getElementById('reconPaotang').value) || 0).toLocaleString('en-US');
            document.getElementById('slipRcBankTotal').innerText = document.getElementById('reconBankTotal').innerText;
            document.getElementById('slipRcDiff').innerText = document.getElementById('reconDiffBox').innerText.replace(/[✅🟡🔴]/g, '').trim();
            document.body.classList.add('printing-recon');
            closeReconModal();
            heroPrint();
        }

        function printSummaryOnly() {
            clearPrintClasses();
            const now = new Date();
            document.getElementById('slipSumDate').innerText = document.getElementById('headDate').innerText;
            document.getElementById('slipSumTime').innerText = now.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
            document.getElementById('slipSumPos').innerText = document.getElementById('headPos').value || '01';
            document.getElementById('slipSumCashier').innerText = document.getElementById('headCashier').value || 'ไม่ระบุชื่อ';
            document.getElementById('slipSumCount').innerText = records.length;
            document.getElementById('slipSumTransfer').innerText = document.getElementById('sumTransfer').innerText;
            document.getElementById('slipSumWelfare').innerText = document.getElementById('sumWelfare').innerText;
            document.getElementById('slipSumThaiplus').innerText = document.getElementById('sumThaiPlus').innerText;
            document.getElementById('slipSumNet').innerText = document.getElementById('sumNet').innerText;
            document.getElementById('slipSumExpense').innerText = document.getElementById('sumExpense').innerText;
            const expenses = records.filter(r => r.type === 'expense');
            document.getElementById('slipSumExpenseCount').innerText = expenses.length;
            document.getElementById('slipSumExpenseBody').innerHTML = expenses.length
                ? expenses.map(r => '<tr><td>' + escapeHTML(r.time) + '</td><td>' + escapeHTML(r.name) + '</td><td>' + (parseFloat(r.amount) || 0).toLocaleString('en-US') + '</td></tr>').join('')
                : '<tr><td colspan="3" style="text-align: center;">- ไม่มีค่าใช้จ่าย -</td></tr>';
            document.body.classList.add('print-summary-only');
            heroPrint();
        }

        window.addEventListener('afterprint', function() { clearPrintClasses(); });

        // ==========================================
        // ส่วนที่ 10: คำนวณ 60:40 ไทยพลัส
        // ==========================================
        var currentMode60 = 'price';
        function open6040Modal() {
            document.getElementById('calc6040Modal').style.display = 'flex';
            document.getElementById('c60Price').value = '';
            document.getElementById('c60Used').value = '';
            document.getElementById('c60Remaining').value = '';
            document.getElementById('c60Wallet').value = '';
            document.getElementById('c60WantPrice').value = '';
            document.getElementById('c60HavePrice').value = '';
            document.getElementById('c60TopupAmt').textContent = '0.00 ฿';
            document.getElementById('c60TopupSub').textContent = 'กรอกเงินตัวเองในกระเป๋าตังก่อน';
            setMode60('price');
            calc60();
            setTimeout(function(){ document.getElementById('c60Price').focus(); }, 150);
        }
        function close6040Modal() { document.getElementById('calc6040Modal').style.display = 'none'; }
        function toggleEg60() { var head = document.getElementById('eg60Head'), body = document.getElementById('eg60Body'); head.classList.toggle('open'); body.classList.toggle('open'); }
        function setRemaining60(val) { document.getElementById('c60Remaining').value = val; document.getElementById('c60Used').value = 200 - val; recalc60(); }
        function setUsed60(val) { document.getElementById('c60Used').value = val; document.getElementById('c60Remaining').value = 200 - val; recalc60(); }
        function setWallet60(val) { document.getElementById('c60Wallet').value = val; recalc60(); }
        function fmt60(n) { return n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
        function setMode60(mode) {
            currentMode60 = mode;
            document.getElementById('m60-price').classList.toggle('active', mode === 'price');
            document.getElementById('m60-money').classList.toggle('active', mode === 'money');
            document.getElementById('m60-topup').classList.toggle('active', mode === 'topup');
            document.getElementById('m60-exact').classList.toggle('active', mode === 'exact');
            document.querySelectorAll('.mode60-field').forEach(function(el) { el.classList.toggle('show', el.getAttribute('data-field') === mode); });
            var oldPanel = document.querySelector('#calc6040Modal .calc-result-panel');
            if (oldPanel) oldPanel.style.display = (mode === 'price') ? 'block' : 'none';
            var btn = document.getElementById('btnSave6040');
            btn.style.display = (mode === 'price') ? 'block' : 'none';
            recalc60();
            setTimeout(function() {
                var focusId = mode === 'price' ? 'c60Price' : mode === 'money' ? 'c60Wallet' : mode === 'topup' ? 'c60WantPrice' : 'c60Remaining';
                var el = document.getElementById(focusId); if (el) el.focus();
            }, 100);
        }
        function recalc60() {
            var remaining = parseFloat(document.getElementById('c60Remaining').value);
            if (!isNaN(remaining) && remaining >= 0 && remaining <= 200) { document.getElementById('c60Used').value = 200 - remaining; }
            if (currentMode60 === 'price') calc60(); else if (currentMode60 === 'money') calcMoney60(); else if (currentMode60 === 'topup') calcTopup60(); else if (currentMode60 === 'exact') calcExact60();
            updateQuotaBar60();
        }
        function updateQuotaBar60() {
            var used = Math.max(0, Math.min(200, parseFloat(document.getElementById('c60Used').value) || 0));
            var remaining = 200 - used;
            var pct = Math.min(100, (used / 200) * 100);
            document.getElementById('c60Bar').style.width = pct + '%';
            document.getElementById('c60Bar').className = 'bar-fill-sm' + (remaining <= 0 ? ' empty' : remaining <= 60 ? ' low' : '');
            document.getElementById('c60UsedLbl').textContent = fmt60(used);
            var remLbl = document.getElementById('c60RemLbl');
            if (remaining <= 0) { remLbl.textContent = 'หมดสิทธิวันนี้'; remLbl.className = 'qrem empty'; }
            else { remLbl.textContent = 'สิทธิคงเหลือ ' + fmt60(remaining) + ' ฿'; remLbl.className = 'qrem' + (remaining <= 60 ? ' low' : ''); }
        }
        function calcMoney60() {
            var W = Math.max(0, parseFloat(document.getElementById('c60Wallet').value) || 0);
            var used = Math.max(0, Math.min(200, parseFloat(document.getElementById('c60Used').value) || 0));
            var Q = 200 - used;
            var alertBox = document.getElementById('c60Alert'), alertMsg = document.getElementById('c60AlertMsg'), alertIcon = document.getElementById('c60AlertIcon');
            if (W <= 0) { document.getElementById('c60MaxBuy').textContent = '0.00 ฿'; document.getElementById('c60MoneySub').textContent = 'กรอกเงินตัวเองในกระเป๋าตังก่อน'; document.getElementById('c60TopupAmt').textContent = '0.00 ฿'; document.getElementById('c60TopupSub').textContent = 'กรอกเงินตัวเองในกระเป๋าตังก่อน'; alertBox.className = 'alert60'; return; }
            var needToCap = (0.6 / 0.4) * W;
            if (needToCap <= Q) { var Pmax = W + needToCap; var govUsed = needToCap; }
            else { var Pmax = W + Q; var govUsed = Q; }
            document.getElementById('c60MaxBuy').textContent = fmt60(Pmax) + ' ฿';
            document.getElementById('c60MoneySub').textContent = 'เงินตัวเอง ' + fmt60(W) + ' + รัฐช่วย ' + fmt60(govUsed) + ' = ของได้สูงสุด ' + fmt60(Pmax) + ' บาท';
            document.getElementById('c60TopupAmt').textContent = fmt60(Pmax - W) + ' ฿';
            document.getElementById('c60TopupSub').textContent = 'ยอดที่ต้องเติม พช = ของที่ซื้อได้สูงสุด - เงินตัวเอง';
            if (Pmax <= 200) { alertBox.className = 'alert60 ok show'; alertIcon.textContent = '✅'; alertMsg.textContent = 'ยังอยู่ในสิทธิ 200 บาท/วัน ไม่มีปัญหา'; }
            else if (govUsed >= Q) { alertBox.className = 'alert60 warn show'; alertIcon.textContent = '⚠️'; alertMsg.textContent = 'สิทธิตันแล้ว! ใช้สิทธิครบ ' + fmt60(used + govUsed) + ' บาท จากวงเงิน 200 บาท'; }
            else { alertBox.className = 'alert60'; }
        }
        function calcTopup60() {
            var wantPrice = Math.max(0, parseFloat(document.getElementById('c60WantPrice').value) || 0);
            var havePrice = Math.max(0, parseFloat(document.getElementById('c60HavePrice').value) || 0);
            var used = Math.max(0, Math.min(200, parseFloat(document.getElementById('c60Used').value) || 0));
            var Q = 200 - used;
            var alertBox = document.getElementById('c60Alert'), alertMsg = document.getElementById('c60AlertMsg'), alertIcon = document.getElementById('c60AlertIcon');
            if (wantPrice <= 0) { document.getElementById('c60TopupAmt2').textContent = '0.00 ฿'; document.getElementById('c60TopupSub2').textContent = 'กรอกราคาสินค้าก่อน'; alertBox.className = 'alert60'; return; }
            var govHelp = Math.min(wantPrice * 0.6, Q);
            var custPay = wantPrice - govHelp;
            var topupNeed = Math.max(0, custPay - havePrice);
            document.getElementById('c60TopupAmt2').textContent = fmt60(topupNeed) + ' ฿';
            document.getElementById('c60TopupSub2').textContent = 'ราคา ' + fmt60(wantPrice) + ' - รัฐช่วย ' + fmt60(govHelp) + ' - มีอยู่แล้ว ' + fmt60(havePrice) + ' = ต้องเติมอีก ' + fmt60(topupNeed) + ' บาท';
            if (topupNeed <= 0) { alertBox.className = 'alert60 ok show'; alertIcon.textContent = '✅'; alertMsg.textContent = 'ไม่ต้องเติมเพิ่ม! เงินที่มีพอจ่ายแล้ว'; }
            else if (govHelp >= Q) { alertBox.className = 'alert60 warn show'; alertIcon.textContent = '⚠️'; alertMsg.textContent = 'สิทธิตันแล้ว รัฐช่วยได้แค่ ' + fmt60(govHelp) + ' บาท'; }
            else { alertBox.className = 'alert60'; }
        }
        // โหมด "ใช้สิทธิพอดี" — ลูกค้าเติมเงินเป๋าตังไว้เยอะแต่ไม่อยากใช้ อยากรู้ราคาสินค้า
        // ขั้นต่ำที่ดึงสิทธิรัฐที่เหลือ (Q) ออกมาใช้ให้หมดพอดี โดยจ่ายผ่านเป๋าตังน้อยที่สุด
        // เท่าที่เป็นไปได้ (govHelp ถูกตรึงที่ Q ทันทีที่ price >= Q/0.6 จุดนั้นคือราคาขั้นต่ำ)
        function calcExact60() {
            var used = Math.max(0, Math.min(200, parseFloat(document.getElementById('c60Used').value) || 0));
            var Q = 200 - used;
            var alertBox = document.getElementById('c60Alert'), alertMsg = document.getElementById('c60AlertMsg'), alertIcon = document.getElementById('c60AlertIcon');
            if (Q <= 0) {
                document.getElementById('c60ExactPrice').textContent = '0.00 ฿';
                document.getElementById('c60ExactSub').textContent = 'สิทธิวันนี้หมดแล้ว ไม่ต้องผ่านระบบนี้ จ่ายด้วยเงินสด/โอนปกติได้เลย';
                alertBox.className = 'alert60';
                return;
            }
            var custMin = Q * (0.4 / 0.6);
            var priceMin = Q + custMin;
            document.getElementById('c60ExactPrice').textContent = fmt60(priceMin) + ' ฿';
            document.getElementById('c60ExactSub').textContent = 'รัฐช่วย ' + fmt60(Q) + ' + จ่ายเอง (พช) ขั้นต่ำ ' + fmt60(custMin) + ' = ราคาขั้นต่ำ ' + fmt60(priceMin) + ' บาท';
            alertBox.className = 'alert60 ok show';
            alertIcon.textContent = '🎯';
            alertMsg.textContent = 'เลือกของราคา ' + fmt60(priceMin) + ' บาทขึ้นไป แล้วกด "ใช้ราคานี้" ด้านล่าง จะดึงสิทธิที่เหลือออกมาใช้หมดพอดี จ่ายผ่านเป๋าตังแค่ ' + fmt60(custMin) + ' บาท — ถ้าอยากได้ของแพงกว่านี้ ส่วนเกินจ่ายแยกด้วยเงินสด/โอนปกติได้เลย ไม่ต้องผ่านเป๋าตังเพิ่ม';
        }
        function useExactPrice60() {
            var used = Math.max(0, Math.min(200, parseFloat(document.getElementById('c60Used').value) || 0));
            var Q = 200 - used;
            if (Q <= 0) return;
            var priceMin = Q + Q * (0.4 / 0.6);
            setMode60('price');
            document.getElementById('c60Price').value = priceMin.toFixed(2);
            calc60();
        }
        function calc60() {
            var price = parseFloat(document.getElementById('c60Price').value) || 0;
            var used = Math.max(0, Math.min(200, parseFloat(document.getElementById('c60Used').value) || 0));
            var Q = 200 - used;
            var govHelp = Math.min(price * 0.6, Q);
            var custPay = price - govHelp;
            var remainingAfter = Q - govHelp;
            document.getElementById('c60CustPay').textContent = fmt60(custPay) + ' ฿';
            document.getElementById('c60RemAfter').textContent = fmt60(remainingAfter) + ' ฿';
            document.getElementById('c60RPrice').textContent = fmt60(price) + ' ฿';
            document.getElementById('c60RGov').textContent = fmt60(govHelp) + ' ฿';
            document.getElementById('c60RCust').textContent = fmt60(custPay) + ' ฿';
            document.getElementById('c60GovNote').textContent = govHelp < price * 0.6 ? '(สิทธิตัน) เหลือ ' + fmt60(remainingAfter) + ' บาท' : '';
            document.getElementById('c60TopupPanel').textContent = fmt60(custPay) + ' ฿';
            var btn = document.getElementById('btnSave6040');
            if (btn) btn.disabled = (price <= 0);
            var formulaBox = document.getElementById('c60Formula');
            if (formulaBox) { if (price > 0) { formulaBox.className = 'formula60 show'; } else { formulaBox.className = 'formula60'; } }
            var alertBox = document.getElementById('c60Alert'), alertMsg = document.getElementById('c60AlertMsg'), alertIcon = document.getElementById('c60AlertIcon');
            if (price <= 0) { alertBox.className = 'alert60'; return; }
            if (govHelp >= Q) { alertBox.className = 'alert60 warn show'; alertIcon.textContent = '⚠️'; alertMsg.textContent = 'สิทธิตันแล้ว! รัฐช่วยได้แค่ ' + fmt60(govHelp) + ' บาท จากวงเงิน 200 บาท (ใช้ไป ' + fmt60(used) + ' บาทแล้ว)'; }
            else { alertBox.className = 'alert60'; }
        }
        function apply6040ToPOS() {
            var price = parseFloat(document.getElementById('c60Price').value) || 0;
            if (price <= 0) { alert('⚠️ กรุณากรอกราคาสินค้าก่อน'); return; }
            var used = Math.max(0, Math.min(200, parseFloat(document.getElementById('c60Used').value) || 0));
            var Q = 200 - used;
            var govHelp = Math.min(price * 0.6, Q);
            var custPay = price - govHelp;
            records.push({ time: new Date().toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'}), type: 'thaiplus', name: 'ลูกค้า (ไทยพลัส)', amount: price, isEdited: false });
            localStorage.setItem('posUltimateRecords', JSON.stringify(records));
            localStorage.setItem('posUltimateDate', new Date().toLocaleDateString('th-TH'));
            document.getElementById('c60Used').value = used + govHelp;
            document.getElementById('c60Remaining').value = 200 - (used + govHelp);
            renderTable();
            if (typeof celebrateTransaction === 'function') celebrateTransaction(price, { moneyIn: false });
            close6040Modal();
        }

        // ==========================================
        // ส่วนที่ 11: 📱 มือถือดักแจ้งเตือน (LAN Relay) — แทนที่ Pushbullet
        // ==========================================
        // android-app/ (โปรเจกต์แยก คนละ repo — ดู README ของมันเอง) พาร์สแจ้งเตือนธนาคาร/วอลเล็ต
        // บนตัวมือถือเอง แล้ว POST เฉพาะ payment event ที่เป็นโครงสร้างชัดเจน (amount/source/เวลา —
        // ไม่มีข้อความแจ้งเตือนดิบ ไม่มีชื่อผู้โอน) มาที่ relay server ที่ embed อยู่ใน main.js ของ
        // แอปนี้เอง (ดู main.js's startRelayServer()) จากนั้น main process ส่งต่อมาที่นี่ผ่าน IPC —
        // ไม่มี WebSocket ให้ต่อ/reconnect อีกต่อไป ฝั่งนี้แค่ "รับฟัง" event ที่ validate มาแล้ว

        // dedup ฝั่ง client เป็นเกราะสำรอง (server ฝั่ง main.js dedupe ด้วย event_id เป็นหลักอยู่แล้ว)
        var _seenPaymentEventIds = (function() {
            try { return JSON.parse(localStorage.getItem('seenPaymentEventIds')) || []; } catch(e) { return []; }
        })();
        function isPaymentEventProcessed(eventId) { return !!eventId && _seenPaymentEventIds.indexOf(eventId) > -1; }
        function markPaymentEventProcessed(eventId) {
            if (!eventId) return;
            _seenPaymentEventIds.push(eventId);
            if (_seenPaymentEventIds.length > 500) _seenPaymentEventIds = _seenPaymentEventIds.slice(-500);
            localStorage.setItem('seenPaymentEventIds', JSON.stringify(_seenPaymentEventIds));
        }

        function setPbStatus(html, cls) {
            const el = document.getElementById('pbStatus');
            if (el) {
                el.innerHTML = html;
                el.className = 'pb-status ' + (cls || '');
            }
            // ไฟ LED (#pbLed / #miniPbLed) เป็นไฟรวมทุกช่องทางแล้ว — ดู updateCombinedLed() ส่วนที่ 12
            if (typeof updateCombinedLed === 'function') updateCombinedLed();
        }

        // [ข้อ 16] บรรทัด log ดิบระดับ debug ([RECV]/[PARSE]/[FOUND]/[RAW]/[POLL] หรือมี eventId/iden
        // ดิบติดมาด้วย) แคชเชียร์ไม่จำเป็นต้องอ่าน แต่ dev ยังไล่ปัญหาได้ — ลดความเด่นแทนการลบทิ้ง
        // (ตรวจจับจากรูปแบบข้อความตรงนี้ที่เดียว ไม่ต้องแก้จุดที่เรียก pbLog ทุกจุด)
        var PB_LOG_TECH_RE = /^\[(RECV|PARSE|FOUND|NOT FOUND|RAW|POLL|ERR)\]|\beventId\b|\biden\b/i;
        function pbLog(msg, type) {
            const box = document.getElementById('pbLog');
            if (!box) return;
            const now = new Date().toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
            const div = document.createElement('div');
            div.className = type ? 'pb-' + type : 'pb-i';
            if (PB_LOG_TECH_RE.test(msg)) div.className += ' pb-tech';
            div.innerHTML = '<span style="color:#bbb;">[' + now + ']</span> ' + msg;
            if (box.children.length === 1 && box.children[0].textContent.indexOf('รอการ') > -1) box.innerHTML = '';
            box.insertBefore(div, box.firstChild);
            if (box.children.length > 30) box.removeChild(box.lastChild);
        }

        // ==========================================
        // ⚙️ CONFIG: ปรับแต่ง mapping แหล่งที่มา → ประเภท POS (ไม่เกี่ยวกับ Pushbullet — คงเดิมทั้งหมด)
        // ==========================================
        function savePbConfig() {
            const cfg = {
                bank:     document.getElementById('pbMapBank')     ? document.getElementById('pbMapBank').value     : 'transfer',
                paotang:  document.getElementById('pbMapPaotang')  ? document.getElementById('pbMapPaotang').value  : 'thaiplus',
                maemanee: document.getElementById('pbMapMaemanee') ? document.getElementById('pbMapMaemanee').value : 'transfer',
                fallback: document.getElementById('pbMapFallback') ? document.getElementById('pbMapFallback').value : 'transfer',
                reconBank:     document.getElementById('pbReconBank')     ? document.getElementById('pbReconBank').checked     : true,
                reconPaotang:  document.getElementById('pbReconPaotang')  ? document.getElementById('pbReconPaotang').checked  : false,
                reconMaemanee: document.getElementById('pbReconMaemanee') ? document.getElementById('pbReconMaemanee').checked : true,
                reconFallback: document.getElementById('pbReconFallback') ? document.getElementById('pbReconFallback').checked : true
            };
            localStorage.setItem('pbConfig', JSON.stringify(cfg));
        }

        function loadPbConfig() {
            try {
                const cfg = JSON.parse(localStorage.getItem('pbConfig'));
                if (!cfg) return;
                if (document.getElementById('pbMapBank')     && cfg.bank)     document.getElementById('pbMapBank').value     = cfg.bank;
                if (document.getElementById('pbMapPaotang')  && cfg.paotang)  document.getElementById('pbMapPaotang').value  = cfg.paotang;
                if (document.getElementById('pbMapMaemanee') && cfg.maemanee) document.getElementById('pbMapMaemanee').value = cfg.maemanee;
                if (document.getElementById('pbMapFallback') && cfg.fallback) document.getElementById('pbMapFallback').value = cfg.fallback;
                if (document.getElementById('pbReconBank')     && cfg.reconBank !== undefined)     document.getElementById('pbReconBank').checked     = cfg.reconBank;
                if (document.getElementById('pbReconPaotang')  && cfg.reconPaotang !== undefined)  document.getElementById('pbReconPaotang').checked  = cfg.reconPaotang;
                if (document.getElementById('pbReconMaemanee') && cfg.reconMaemanee !== undefined) document.getElementById('pbReconMaemanee').checked = cfg.reconMaemanee;
                if (document.getElementById('pbReconFallback') && cfg.reconFallback !== undefined) document.getElementById('pbReconFallback').checked = cfg.reconFallback;
            } catch(e) {}
        }

        function getPbConfig() {
            try { const saved = JSON.parse(localStorage.getItem('pbConfig')); if (saved) return saved; } catch(e) {}
            return { bank: 'transfer', paotang: 'thaiplus', maemanee: 'transfer', fallback: 'transfer', reconBank: true, reconPaotang: false, reconMaemanee: true, reconFallback: true };
        }

        document.addEventListener('DOMContentLoaded', function() {
            loadPbConfig();
            // [ข้อ 14] ข้อความนี้พูดถึงเฉพาะแอป "POS Relay" (relay:status จาก main.js) — เดิมเขียนแค่
            // "มือถือ" เฉยๆ ทำให้สับสนกับ Pushbullet/MacroDroid ที่อยู่ในหน้าเดียวกัน
            setPbStatus('⏸️ POS Relay: รอมือถือเชื่อมต่อครั้งแรก', '');
        });

        // แปลง source ที่มือถือส่งมา (ต้องตรงกับ android-app/parser-spec/patterns.json sources[])
        // ให้เป็นกลุ่ม/ป้ายชื่อที่ POS Hero ใช้อยู่แล้ว — bank1/bank2 คือสองบัญชีธนาคารจริงของร้าน
        // (แยกช่องกระทบยอด reconBank1/reconBank2 คนละช่อง) ไม่ใช่ "กลุ่มธนาคาร 1 vs 2" ทั่วไป
        var SOURCE_TO_GROUP = {
            scb: 'bank1', krungsri: 'bank1', ktb: 'bank1',
            kplus: 'bank2', bbl: 'bank2', ttb: 'bank2',
            paotang: 'paotang', truemoney: 'paotang', thungngern: 'paotang',
            maemanee: 'maemanee',
            unknown: 'fallback'
        };
        var SOURCE_LABELS = {
            scb: 'SCB', krungsri: 'กรุงศรี', ktb: 'กรุงไทย',
            kplus: 'K PLUS', bbl: 'กรุงเทพ', ttb: 'ttb',
            paotang: 'เป๋าตัง', truemoney: 'TrueMoney', thungngern: 'ถุงเงิน',
            maemanee: 'แม่มณี', unknown: 'ไม่ทราบแหล่งที่มา'
        };
        // ป้ายชื่ออ่านง่าย สำหรับกลุ่มที่ detectSource() (ใช้ร่วม Pushbullet/Firebase/วงเน็ต) คืนมา —
        // ('bank1'/'bank2'/ฯลฯ) — ใช้แค่แสดงผลใน log/โหมดทดสอบ (ข้อ 16) ไม่กระทบการจัดกลุ่มจริง
        var GROUP_LABELS = { bank1: 'ธนาคาร', bank2: 'ธนาคาร', paotang: 'เป๋าตัง/ถุงเงิน', maemanee: 'แม่มณี', fallback: 'ไม่ทราบแหล่งที่มา' };

        // ==========================================
        // injectPaymentEvent — บันทึกยอดเข้าตาราง POS + autofill ช่องกระทบยอด
        // (เดิมคือ pbInject) — android-app ตอนนี้ส่งชื่อผู้โอนมาด้วยแบบ best-effort (ไม่ใช่ทุกแหล่งที่มา
        // จะมี) ถ้ามี senderName ใช้ชื่อจริงในรายการ ถ้าไม่มีก็ fallback กลับไปเป็น "โอนผ่าน <แหล่งที่มา>"
        // เหมือนเดิม — ไม่ว่ากรณีไหน ค่าที่มาจากภายนอก (network) จะถูก escapeHTML ตอน render เสมอ (renderTable)
        // ==========================================

        // [ข้อ 5 feedback แอ๋ม] เปิดหน้าต่างกระทบยอดค้างไว้แล้วมีเงินเข้า — ฝั่ง "POS เครื่องที่ 1"
        // (reconPos1Transfer) เดิมคำนวณครั้งเดียวตอนเปิด modal (openReconModal) เท่านั้น ไม่เคยถูก
        // รีเฟรชอีกเลยตอนมีรายการใหม่เข้าตาราง ต่างจากฝั่งธนาคาร/เป๋าตังที่รายการอัตโนมัติเติมให้เอง
        // → เรียกฟังก์ชันนี้ทุกครั้งหลัง renderTable() จากช่องทางอัตโนมัติ เพื่อให้ตัวเลขสองฝั่งขยับพร้อมกัน
        function refreshReconPosIfOpen() {
            var modal = document.getElementById('reconModal');
            if (!modal || modal.style.display !== 'flex') return;
            var t = 0;
            records.forEach(function(r) { if (r.type === 'transfer') t += Math.round((parseFloat(r.amount) || 0) * 100); });
            var el = document.getElementById('reconPos1Transfer');
            if (el) el.value = t > 0 ? (t / 100) : '';
            calcRecon();
        }

        function injectPaymentEvent(amount, group, sourceLabel, senderName) {
            var cfg = getPbConfig();
            var toTable = document.getElementById('pbToTable') ? document.getElementById('pbToTable').checked : true;

            var mapKey = (group === 'bank1' || group === 'bank2') ? 'bank' : group;
            var recType = cfg[mapKey] || 'transfer';
            var doRecon = cfg['recon' + mapKey.charAt(0).toUpperCase() + mapKey.slice(1)];
            if (doRecon === undefined) doRecon = true;

            var recordName = senderName ? ('โอนจาก ' + senderName) : ('โอนผ่าน ' + sourceLabel);

            // 1. ใส่เข้าตารางหลัก POS
            if (toTable) {
                var timeStr = new Date().toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
                records.push({
                    time: timeStr,
                    type: recType,
                    name: recordName,
                    amount: amount,
                    isEdited: false
                });
                localStorage.setItem('posUltimateRecords', JSON.stringify(records));
                localStorage.setItem('posUltimateDate', new Date().toLocaleDateString('th-TH'));
                renderTable();
                refreshReconPosIfOpen();
                pbLog('✅ บันทึก: +' + amount.toLocaleString('en-US') + ' ฿ (' + recordName + ')', 'm');
                if (window.heroWindow && window.heroWindow.notifyMoneyIn) {
                    window.heroWindow.notifyMoneyIn(amount, recordName, recType);
                }
                if (typeof celebrateTransaction === 'function') celebrateTransaction(amount, { moneyIn: true });
            }

            // 2. ใส่เข้าช่องกระทบยอด
            if (doRecon && document.getElementById('reconModal') && document.getElementById('reconModal').style.display === 'flex') {
                var fieldId = null;
                if (group === 'paotang') fieldId = 'reconPaotang';
                // ช่อง 1 = ธนาคารกรุงเทพ (เงินเข้าธนาคารอื่นก็ลงช่องนี้), ช่อง 2 = ธนาคารของแม่มณี
                else if (group === 'maemanee') fieldId = 'reconBank2';
                else fieldId = 'reconBank1';

                var el = document.getElementById(fieldId);
                if (el) {
                    var oldVal = parseFloat(el.value) || 0;
                    var newVal = oldVal + amount;
                    el.value = newVal;
                    calcRecon();
                    el.style.background = '#dcfce7';
                    el.style.borderColor = '#16a34a';
                    setTimeout(function() { el.style.background = ''; el.style.borderColor = ''; }, 900);
                    pbLog('📱 กระทบยอด: +' + amount.toLocaleString('en-US') + ' ฿ → ' + fieldId, 'i');
                }
            }
        }

        // ==========================================
        // handlePaymentEvent — event ที่ main.js validate แล้วส่งเข้ามาผ่าน IPC (ดู preload.js
        // onPaymentEvent) รูปร่างคงที่เสมอ (v1/event_id/amount/currency/source/occurred_at/is_test)
        // ไม่ต้องเดา/พาร์สข้อความอีกต่อไป (ต่างจาก handlePbPush เดิม)
        // ==========================================
        function handlePaymentEvent(payload) {
            if (!payload || typeof payload.amount !== 'number') return;
            if (payload.event_id && isPaymentEventProcessed(payload.event_id)) {
                pbLog('⏭️ ข้าม (ประมวลผลแล้ว): ' + payload.event_id, 'i');
                return;
            }
            if (payload.event_id) markPaymentEventProcessed(payload.event_id);

            // รายการทดสอบ (จากปุ่ม "ทดสอบส่งรายการโอนจำลอง" ในแอปมือถือ) — แค่ยืนยันว่าเส้นทาง
            // มือถือ → server → ที่นี่ทำงานจริง ไม่บันทึกลงรายการขายจริง
            if (payload.is_test) {
                pbLog('🧪 ทดสอบสำเร็จ: +' + payload.amount.toLocaleString('en-US') + ' ฿ (ไม่บันทึกเข้าตารางจริง)', 'm');
                return;
            }

            var group = SOURCE_TO_GROUP[payload.source] || 'fallback';
            var label = SOURCE_LABELS[payload.source] || 'ไม่ทราบแหล่งที่มา';
            injectPaymentEvent(payload.amount, group, label, payload.sender_name);
        }

        if (window.heroWindow && window.heroWindow.onPaymentEvent) {
            window.heroWindow.onPaymentEvent(handlePaymentEvent);
        }

        // สถานะ "มือถือยังส่งสัญญาณอยู่ไหม" — main.js เป็นคนตัดสิน (นับจาก /ping และ /notify ที่ผ่าน
        // token ถูก, ดู main.js's watchdog) แล้วส่งมาทาง IPC ทีเดียว ไม่ต้องมี timer ฝั่งนี้อีกต่อไป
        if (window.heroWindow && window.heroWindow.onRelayStatus) {
            window.heroWindow.onRelayStatus(function(status) {
                if (!status) return;
                appRelayState = status.state;
                // setPbStatus ด้านล่างเรียก updateCombinedLed ให้อยู่แล้ว
                // [ข้อ 14] ระบุชื่อช่องทาง "POS Relay" ให้ชัด ไม่ใช่แค่ "มือถือ" เฉยๆ
                if (status.state === 'ok') setPbStatus('🟢 POS Relay: เชื่อมต่อปกติ', 'ok');
                else if (status.state === 'err') setPbStatus('🔴 POS Relay: ไม่ได้ยินจากมือถือ', 'err');
                else setPbStatus('⏸️ POS Relay: รอมือถือเชื่อมต่อครั้งแรก', '');
                // มีการเชื่อมต่อ/ปัญหาจริงเกิดขึ้นกับระบบเดิมนี้ → เปิดกล่องให้เห็นแทนที่จะพับซ่อนไว้
                var box = document.getElementById('legacyRelayBox');
                if (box && (status.state === 'ok' || status.state === 'err')) box.open = true;
            });
        }

        // ปุ่ม "📶 ดูข้อมูลเชื่อมต่อ" ใน pb-box — เอา IP/Token ที่ main.js สุ่มไว้ให้ไปตั้งค่าในแอปมือถือ
        function showRelayInfo() {
            if (!window.heroWindow || !window.heroWindow.getRelayInfo) return;
            window.heroWindow.getRelayInfo().then(function(info) {
                if (!info) return;
                var ipText = info.ips && info.ips.length ? info.ips.join(' หรือ ') : 'ไม่พบ IP วง LAN (เช็ค WiFi)';
                alert('ตั้งค่าในแอป "POS Relay" บนมือถือ:\n\nServer: ' + ipText + ':' + info.port + '\nToken: ' + info.token);
            });
        }

        // ==========================================
        // ส่วนที่ 11b: 🔗 PUSHBULLET WEBSOCKET — ช่องทางเดิม นำกลับมาใช้คู่กับ relay/inbox
        // [FIX #6] รวมระบบทั้งหมดในที่เดียว + แก้ WebSocket heartbeat + reconnect เร็วขึ้น
        // ==========================================
        let pbWs = null;
        let pbToken = localStorage.getItem('pbToken') || '';
        let pbReconnectTimer = null;
        let pbDisconnectStart = 0; // [FIX] บันทึกเวลาที่ disconnect
        let pbLastActivity = 0; // [FIX #13] เวลาล่าสุดที่ได้รับข้อความใดๆ จาก Pushbullet (รวม nop)
        let pbLastWarnAt = 0; // เวลาล่าสุดที่เด้ง notification เตือนหลุดการเชื่อมต่อ (กันสแปม)

        // [BACKFILL] dedup ถาวรด้วย push.iden — กันนับซ้ำระหว่าง realtime WS กับ poll backfill
        // (ต่างจาก signature 3 วิใน pbInject ที่ออกแบบมากันแค่ push/mirror เด้งซ้อนกันตอนเดียว)
        var _pbProcessedIdens = (function() {
            try { return JSON.parse(localStorage.getItem('pbProcessedIdens')) || []; } catch(e) { return []; }
        })();
        function isPushProcessed(iden) { return !!iden && _pbProcessedIdens.indexOf(iden) > -1; }
        function markPushProcessed(iden) {
            if (!iden) return;
            _pbProcessedIdens.push(iden);
            if (_pbProcessedIdens.length > 500) _pbProcessedIdens = _pbProcessedIdens.slice(-500);
            localStorage.setItem('pbProcessedIdens', JSON.stringify(_pbProcessedIdens));
        }

        // [FIX #6] ตัวแปรสำหรับ debounce + dedup
        let _pbInjectQueue = [];
        let _pbInjectProcessing = false;
        window._lastPbSig = "";
        window._lastPbTime = 0;

        // โหลด token + config ที่เคยบันทึกไว้ + auto-connect ทันทีถ้ามี token
        // (เดิมเชื่อมต่อก็ต่อเมื่อเปิด Modal กระทบยอดครั้งแรกของเซสชันเท่านั้น —
        // ทำให้ไฟสถานะ Pushbullet ค้างเทาไปเรื่อยๆ ถ้าไม่เคยเปิด modal นั้นเลย)
        document.addEventListener('DOMContentLoaded', function() {
            const t = document.getElementById('pbToken');
            if (t && pbToken) t.value = pbToken;
            if (pbToken) connectPushbullet();
            // [ข้อ 14] "เปิดใช้" (ติ๊ก inboxPbEnabled) กับ "เชื่อมต่อแล้ว" เป็นคนละเรื่อง — ติ๊กเปิดใช้ไว้
            // แต่ยังไม่ใส่ Token ก็ยังเชื่อมต่อไม่ได้ เดิมข้อความ "ยังไม่เชื่อมต่อ" เฉยๆ ทำให้ดูขัดกับ
            // ติ๊กที่เปิดอยู่ → บอกเหตุผลตรงๆ ว่ายังไม่ได้ใส่ Token
            else setPbWsStatus('⏸️ ยังไม่ได้ใส่ Token', '');
        });

        // สถานะ Pushbullet แยกจาก #pbStatus (ของ relay) — ไฟ LED รวมอยู่ใน updateCombinedLed()
        var pbWsState = 'off'; // off | connecting | ok | err
        function setPbWsStatus(html, cls) {
            var el = document.getElementById('pbWsStatus');
            if (el) { el.innerHTML = html; el.className = 'pb-status ' + (cls || ''); }
            pbWsState = cls === 'ok' ? 'ok' : cls === 'warn' ? 'connecting' : cls === 'err' ? 'err' : 'off';
            // [ข้อ 14] จริงจังกับระบบเดิมนี้แล้ว (เชื่อมต่อได้ หรือเจอปัญหาจริง) → เปิดกล่องให้เห็น
            var box = document.getElementById('legacyRelayBox');
            if (box && (cls === 'ok' || cls === 'err')) box.open = true;
            if (typeof updateCombinedLed === 'function') updateCombinedLed();
        }

        // ==========================================
        // [FIX #6] WebSocket Connection + Heartbeat + Reconnect
        // ==========================================
        function connectPushbullet() {
            if (typeof inboxCfg !== 'undefined' && inboxCfg && inboxCfg.pbEnabled === false) {
                setPbWsStatus('⏸️ ปิดอยู่ (ตั้งค่าใน 📥 ช่องทางรับเงินเข้า)', '');
                return;
            }
            const input = document.getElementById('pbToken');
            pbToken = (input ? input.value : '').trim();
            if (!pbToken) { alert('⚠️ กรุณาใส่ Pushbullet Access Token'); return; }
            if (!pbToken.startsWith('o.')) { alert('⚠️ Token ต้องขึ้นต้นด้วย o.'); return; }
            localStorage.setItem('pbToken', pbToken);
            disconnectPushbullet();
            setPbWsStatus('🟡 กำลังเชื่อมต่อ...', 'warn');

            try {
                // จับ socket ตัวนี้ไว้ใน closure — handler ของ socket ตัวเก่า (ที่ถูก close ไปตอนต่อใหม่)
                // ยิง onclose ตามมาทีหลังแบบ async ถ้าไม่เช็คจะไปเขียนทับ pbWs ของตัวใหม่เป็น null
                // แล้วสั่ง reconnect ซ้อนจนมี socket ค้างหลายตัว (รับ push ซ้ำ) — ยิ่งสำคัญตอนนี้ที่
                // ต่อใหม่ทุกครั้งที่เครือข่ายเปลี่ยน
                var ws = new WebSocket('wss://stream.pushbullet.com/websocket/' + pbToken);
                pbWs = ws;

                ws.onopen = function() {
                    if (pbWs !== ws) return;
                    pbDisconnectStart = 0; // [FIX] รีเซ็ตเวลา disconnect
                    pbLastWarnAt = 0;
                    pbLastActivity = Date.now();
                    setPbWsStatus('🟢 เชื่อมต่อแล้ว (รอแจ้งเตือน)', 'ok');
                    pbLog('🔗 เชื่อมต่อสำเร็จ รอรับ push...', 'i');
                    inboxOnChannelUp('pb');
                    // [BACKFILL] จังหวะเพิ่งต่อ WS สำเร็จ มักตรงกับตอนมือถือเพิ่งตื่นจาก
                    // Doze/background throttling แล้ว flush queue แจ้งเตือนที่ค้างไป Pushbullet
                    // พอดี → เช็คย้อนหลังทันทีแทนที่จะรอรอบ interval ถัดไป
                    pollMissedPushes();
                };

                ws.onmessage = function(ev) {
                    if (pbWs !== ws) return;
                    pbLastActivity = Date.now(); // [FIX #13] ทุกข้อความที่เข้ามา (รวม nop) คือสัญญาณว่า socket ยังมีชีวิต
                    try {
                        const data = JSON.parse(ev.data);
                        if (data.type) { pbLog('[RAW] type=' + data.type, 'i'); }
                        let pushObj = null;
                        if (data.type === 'push' && data.push) { pushObj = data.push; }
                        else if (data.type === 'mirror' && data.push) { pushObj = data.push; }
                        else if (data.title || data.body) { pushObj = data; }
                        if (pushObj) {
                            pbLog('[RECV] ' + (pushObj.title || '').substring(0,30) + '...', 'i');
                            handlePbPush(pushObj);
                        }
                    } catch(e) { pbLog('[ERR] parse: ' + e.message, 'e'); }
                };

                ws.onclose = function() {
                    if (pbWs !== ws) return;
                    pbWs = null;
                    pbDisconnectStart = Date.now(); // [FIX] บันทึกเวลาตัดการเชื่อมต่อ
                    setPbWsStatus('🔴 ตัดการเชื่อมต่อ', 'err');
                    inboxOnChannelDown('pb');
                    schedulePbReconnect();
                };

                ws.onerror = function(err) {
                    if (pbWs !== ws) return;
                    setPbWsStatus('❌ เชื่อมต่อล้มเหลว', 'err');
                    pbLog('ตรวจสอบ Token หรือเน็ต', 'e');
                    pbWs = null;
                    pbDisconnectStart = Date.now(); // [FIX] บันทึกเวลาตัดการเชื่อมต่อ
                    inboxOnChannelDown('pb');
                    schedulePbReconnect();
                };

            } catch(e) { alert('เชื่อมต่อไม่ได้: ' + e.message); }
        }

        function disconnectPushbullet() {
            if (pbReconnectTimer) { clearTimeout(pbReconnectTimer); pbReconnectTimer = null; }
            if (pbWs) { pbWs.close(); pbWs = null; }
            setPbWsStatus('⏸️ ยังไม่เชื่อมต่อ', '');
            pbLog('ตัดการเชื่อมต่อแล้ว', 'i');
        }

        function schedulePbReconnect() {
            if (pbReconnectTimer) clearTimeout(pbReconnectTimer);
            pbReconnectTimer = setTimeout(function() {
                if (!pbWs && pbToken) {
                    pbLog('🔄 พยายามเชื่อมต่อใหม่...', 'w');
                    connectPushbullet();
                }
            }, 3000); // [FIX] ลดจาก 8 วินาที → 3 วินาที เพื่อ reconnect เร็วขึ้น
        }

        // [FIX #13] Pushbullet Realtime Event Stream เป็นช่องทางเดียว (server → client เท่านั้น)
        // ไม่มี client protocol ให้ส่งอะไรกลับ — เซิร์ฟเวอร์เองส่ง nop คงสถานะทุก ~30 วิอยู่แล้ว
        // เดิมโค้ดยิง send() เฟรมที่ไม่ตรงสเปกทุก 25 วิ ("heartbeat") ซึ่งไม่ช่วยอะไรและเสี่ยงโดน
        // เซิร์ฟเวอร์ตัดการเชื่อมต่อเองเพราะได้รับข้อมูลที่ไม่รู้จัก → เอาออก ใช้ nop ที่เซิร์ฟเวอร์ส่งมา
        // (จับเวลาไว้ใน pbLastActivity ทุกครั้งที่ onmessage ทำงาน) เป็นตัวจับชีพจรแทน

        // [FIX #6/#13] ตรวจสอบสถานะ WebSocket ทุก 10 วินาที
        setInterval(function() {
            if (pbWs && pbWs.readyState === WebSocket.OPEN && pbLastActivity && (Date.now() - pbLastActivity) > 35000) {
                // readyState ยังโชว์ OPEN แต่ไม่มีสัญญาณ (แม้แต่ nop) เข้ามาเลยเกิน 35 วิ = socket ค้างเงียบๆ
                pbLog('🔴 ไม่มีสัญญาณจาก Pushbullet นานเกิน 35 วินาที → ตัดแล้วเชื่อมต่อใหม่', 'e');
                pbWs.close();
            } else if (pbToken && !pbWs && pbDisconnectStart && (Date.now() - pbDisconnectStart) > 30000) {
                pbLog('🔴 Warning: ไม่ได้ยินเตือนนานเกิน 30 วินาที! ตรวจสอบ Pushbullet', 'e');
                // native notification ย้ายไปยิงตาม "ไฟรวม" แทน (checkCombinedAlert, ส่วนที่ 12) —
                // Pushbullet หลุดอย่างเดียวแต่ Firebase/วงเน็ตยังรับได้ ไม่ต้องเด้งเตือน
            }
        }, 10000);

        // [FIX #11] มือถือ/แท็บเล็ตจะ "หรี่" ปิด setInterval/WebSocket เมื่อสลับแอปหรือดับหน้าจอ
        // ทำให้การเชื่อมต่อหลุดเงียบๆ โดยไม่มี event onclose มาสั่ง reconnect
        // → บังคับเชื่อมต่อใหม่ทันทีเมื่อกลับมาเปิดหน้าจอ/สลับกลับมาที่แท็บนี้
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible' && pbToken) {
                if (!pbWs || pbWs.readyState !== WebSocket.OPEN) {
                    pbLog('👁️ กลับมาที่หน้าจอ → เชื่อมต่อ Pushbullet ใหม่', 'w');
                    connectPushbullet();
                }
            }
        });

        // เครื่องหลับ/ล็อกหน้าจอเป็นจุดที่ WebSocket หลุดเงียบๆ บ่อยที่สุด (บางครั้ง onclose
        // ไม่ยิงทันทีตอนตื่นเครื่อง) → main process จะสั่งบังคับเชื่อมต่อใหม่ทันทีที่ตื่น/ปลดล็อก
        if (window.heroWindow && window.heroWindow.onForceReconnect) {
            window.heroWindow.onForceReconnect(function() {
                if (!pbToken) return;
                pbLog('🔌 เครื่องกลับมาทำงาน (resume/unlock) → บังคับเชื่อมต่อ Pushbullet ใหม่', 'w');
                disconnectPushbullet();
                connectPushbullet();
                // [BACKFILL] เผื่อมีแจ้งเตือนเข้ามาระหว่างที่เครื่องหลับ/ล็อกอยู่
                pollMissedPushes();
            });
        }

        // เน็ตหลุด-กลับมา (WiFi สะดุด) ก็เป็นอีกจุดที่ทำให้ socket ค้าง
        window.addEventListener('online', function() {
            if (pbToken && (!pbWs || pbWs.readyState !== WebSocket.OPEN)) {
                pbLog('🌐 อินเทอร์เน็ตกลับมา → เชื่อมต่อ Pushbullet ใหม่', 'w');
                connectPushbullet();
            }
        });

        // ==========================================
        // [FIX #7] extractMoney — ดึงตัวเลขอัจฉริยะ
        // [FIX] ใช้ท่าไม้ตาย 1-2 ก่อน + return ตัวที่ใหญ่ที่สุดเสมอ
        // ==========================================
        function extractMoney(text) {
            if (!text) return null;
            const t = text;
            pbLog('[PARSE] "' + escapeHTML(t.substring(0,60).replace(/\n/g,' ')) + '"', 'i');

            // ท่าไม้ตาย 1: จับคู่คำว่า "บาท" หรือ "฿" โดยตรง (เช่น "69 บาท")
            let match1 = t.match(/([\d,]+(?:\.\d+)?)\s*(?:บาท|฿|thb)/i);
            if (match1 && match1[1]) {
                let num = parseFloat(match1[1].replace(/,/g, ''));
                if (num > 0 && num <= 999999) { pbLog('[FOUND] เจอคำว่าบาท: ' + num, 'i'); return num; }
            }

            // ท่าไม้ตาย 2: จับหลังคำแอคชัน (เช่น "เงินเข้า 69")
            let match2 = t.match(/(?:เงินเข้า|รับโอน|ยอดเงิน|โอนเงินเข้า|จำนวน|ได้รับ|จำนวนเงิน)\s*([\d,]+(?:\.\d+)?)/i);
            if (match2 && match2[1]) {
                let num = parseFloat(match2[1].replace(/,/g, ''));
                if (num > 0 && num <= 999999) { pbLog('[FOUND] เจอคำสั่งเงินเข้า: ' + num, 'i'); return num; }
            }

            // ท่าไม้ตาย 3: ของเดิม (เผื่อรูปแบบแปลก)
            let clean = t.replace(/฿/g, '').replace(/บาท/g, '').replace(/บ\./g, '').replace(/B\./g, '').replace(/THB/gi, '');

            let m3 = clean.match(/(\d{1,3}(?:,\d{3})+\.\d{2})/g);
            if (m3) {
                const nums = m3.map(s => parseFloat(s.replace(/,/g,''))).filter(n => n > 0 && n <= 999999);
                if (nums.length) { pbLog('[FOUND] comma-decimal: ' + Math.max.apply(null,nums), 'i'); return Math.max.apply(null,nums); }
            }

            m3 = clean.match(/(\d{1,3}(?:,\d{3})+)/g);
            if (m3) {
                const nums = m3.map(s => parseFloat(s.replace(/,/g,''))).filter(n => n > 0 && n <= 999999);
                if (nums.length) { pbLog('[FOUND] comma: ' + Math.max.apply(null,nums), 'i'); return Math.max.apply(null,nums); }
            }

            m3 = clean.match(/(\d+\.\d{2})/g);
            if (m3) {
                const nums = m3.map(s => parseFloat(s)).filter(n => n > 0 && n <= 999999);
                if (nums.length) { pbLog('[FOUND] decimal: ' + Math.max.apply(null,nums), 'i'); return Math.max.apply(null,nums); }
            }

            // [FIX] ท่าไม้ตาย 4: ใช้ Math.max เสมอ (ไม่ใช่ nums[0]) + filter ปี/เวลา
            let m4 = clean.match(/(\d{4,})/g);
            if (m4) {
                const nums = m4.map(s => parseFloat(s)).filter(n => n > 0 && n <= 999999 && !(n >= 2500 && n <= 2600) && !(n >= 2020 && n <= 2030));
                if (nums.length) { pbLog('[FOUND] plain: ' + Math.max.apply(null,nums), 'i'); return Math.max.apply(null,nums); }
            }

            if (/เงิน|โอน|รับ|เข้า|received|transfer|incoming/i.test(t)) {
                m4 = clean.match(/(\d{3,})/g);
                if (m4) {
                    const nums = m4.map(s => parseFloat(s)).filter(n => n > 0 && n <= 999999 && !(n >= 2500 && n <= 2600) && !(n >= 2020 && n <= 2030));
                    if (nums.length) { pbLog('[FOUND] keyword+3digit: ' + Math.max.apply(null,nums), 'i'); return Math.max.apply(null,nums); }
                }
            }

            pbLog('[NOT FOUND] ไม่พบตัวเลข', 'e');
            return null;
        }

        // ==========================================
        // [FIX #8] detectSource — ตรวจจับแหล่งที่มาแบบกว้างขึ้น
        // ==========================================
        function detectSource(text) {
            const t = (text || '').toLowerCase();

            // Mae Manee แยกออกมาก่อน
            if (t.indexOf('mae manee') > -1 || t.indexOf('maemanee') > -1 || t.indexOf('แม่มณี') > -1) return 'maemanee';

            // เป๋าตัง / ถุงเงิน / TrueMoney
            if (t.indexOf('paotang') > -1 || t.indexOf('เป๋าตัง') > -1 ||
                t.indexOf('ถุงเงิน') > -1 || t.indexOf('tungngoen') > -1 || t.indexOf('tung ngoen') > -1 ||
                t.indexOf('pao tang') > -1 || t.indexOf('truemoney') > -1 || t.indexOf('ทรูมันนี่') > -1 ||
                t.indexOf('true money') > -1 || t.indexOf('wallet') > -1 || t.indexOf('เป๋าตัง') > -1) return 'paotang';

            // ธนาคาร — เพิ่มธนาคารมากขึ้น
            if (t.indexOf('scb') > -1 || t.indexOf('ไทยพาณิชย์') > -1 || t.indexOf('scb easy') > -1 || t.indexOf('scbeasy') > -1) return 'bank1';
            if (t.indexOf('k plus') > -1 || t.indexOf('กสิกร') > -1 || t.indexOf('kbank') > -1 || t.indexOf('kasikorn') > -1 || t.indexOf('k-plus') > -1 || t.indexOf('kplus') > -1) return 'bank2';
            if (t.indexOf('krungsri') > -1 || t.indexOf('กรุงศรี') > -1 || t.indexOf('ayudhya') > -1) return 'bank1';
            if (t.indexOf('bangkok bank') > -1 || t.indexOf('กรุงเทพ') > -1 || t.indexOf('bbl') > -1) return 'bank2';
            if (t.indexOf('krungthai') > -1 || t.indexOf('กรุงไทย') > -1 || t.indexOf('krung thai') > -1) return 'bank1';
            if (t.indexOf('ttb') > -1 || t.indexOf('ทหารไทย') > -1 || t.indexOf('thanachart') > -1) return 'bank2';
            if (t.indexOf('ออมสิน') > -1 || t.indexOf('gsb') > -1 || t.indexOf('govbank') > -1) return 'bank1';
            if (t.indexOf('เกษตร') > -1 || t.indexOf('baac') > -1) return 'bank2';
            if (t.indexOf('กรุงศรี') > -1 || t.indexOf('กรุงศรี') > -1) return 'bank1';
            if (t.indexOf('uob') > -1 || t.indexOf('ยูโอบี') > -1) return 'bank2';

            // Fallback: ใช้ keyword ทั่วไป
            if (t.indexOf('เงินเข้า') > -1 || t.indexOf('รับโอน') > -1 || t.indexOf('received') > -1 ||
                t.indexOf('transfer') > -1 || t.indexOf('incoming') > -1 || t.indexOf('รับเงิน') > -1) return 'bank1';

            return null;
        }

        // ==========================================
        // [FIX #9] pbInject — รวมจาก Override Patch + แก้ Dedup
        // [FIX #4] ลด Dedup Window จาก 10 → 3 วินาที + ใช้ Signature ที่เฉพาะเจาะจงกว่า
        // ==========================================
        // ชื่อรายการอัตโนมัติ — [FIX] ดึงชื่อให้สั้นกระชับ (regex เดิม แยกออกมาให้โหมดทดสอบใช้ดูผลได้ด้วย)
        function pbShortName(fullTextToParse) {
            var shortName = "";
            var match = fullTextToParse.match(/จาก\s*(.*?)(?:\s*วันที่|\s*เวลา|\s*จำนวน|\s*ยอด|$)/);
            if (match && match[1]) {
                shortName = match[1].trim();
            } else {
                shortName = fullTextToParse.trim().substring(0, 15);
            }
            if (shortName.length > 25) shortName = shortName.substring(0, 25) + '...';
            if (!shortName || shortName === "") shortName = "ลูกค้าโอน";
            return shortName;
        }

        // meta (optional) = { channel, eventId, sig } — มาจาก ingestMoneyEvent (ส่วนที่ 12)
        // คืนค่า record ที่บันทึกลงตาราง (หรือ null ถ้าข้าม/ไม่ได้บันทึกลงตาราง)
        function pbInject(amount, srcType, rawTitle, rawBody, meta) {
            // --- ระบบป้องกันการบันทึกซ้ำซ้อน (Deduplication) ---
            var now = Date.now();
            var fullTextToParse = ((rawBody || '') + " " + (rawTitle || '')).replace(/\n/g, ' ');

            // [FIX] ใช้ข้อความเต็มแทนตัด 30 ตัวแรก — เดิมตัดสั้นเกินไป ทำให้สองรายการที่
            // "ยอดเท่ากันพอดี" จากคนละคนซึ่งเข้ามาไม่ถึง 3 วิ (ปกติมากตอนลูกค้าเยอะๆ จ่ายเลขกลมๆ
            // เช่น 20/50/100 บาท พร้อมกัน) ถูกมองว่าเป็น push+mirror ซ้ำกันของรายการเดียว ทั้งที่
            // ชื่อผู้โอนจริงต่างกัน (แค่บังเอิญอยู่หลังตำแหน่งที่ 30 ของเทมเพลตแจ้งเตือนธนาคาร) —
            // เลยถูกข้ามไปเงียบๆ ไม่บันทึกทั้งที่เป็นรายการจริง ข้อความเต็มยังจับ push+mirror ของ
            // เหตุการณ์เดียวกันได้เหมือนเดิม (เนื้อหาเหมือนกันทุกตัวอักษร) แต่ไม่ชนกับรายการอื่นที่
            // ชื่อผู้โอนต่างกันอีกต่อไป
            var sig = amount + "_" + fullTextToParse;

            // [FIX #4] ลด window จาก 10 วินาที → 3 วินาที (กันแอปเด้งเบิ้ล push+mirror)
            // ใช้เฉพาะ Pushbullet (ต้นเหตุ push+mirror ซ้อน) — Firebase/วงเน็ตกันซ้ำด้วย eventId แทน
            // ถ้าใช้กับช่องทางนั้นด้วย โอนจริง 2 ครั้งยอด/ข้อความเหมือนกันภายใน 3 วิจะหายไป 1 รายการ
            var isPbChannel = !meta || meta.channel === 'pb';
            if (isPbChannel && window._lastPbSig === sig && (now - window._lastPbTime) < 3000) {
                pbLog('⚠️ ข้ามการบันทึกซ้ำซ้อนภายใน 3 วินาที', 'w');
                return null;
            }
            if (isPbChannel) {
                window._lastPbSig = sig;
                window._lastPbTime = now;
            }
            // ---------------------------------------------

            var cfg = getPbConfig();
            var toTable = document.getElementById('pbToTable') ? document.getElementById('pbToTable').checked : true;

            // แมพแหล่งที่มา → config key
            var mapKey = srcType || 'fallback';
            if (srcType === 'bank1' || srcType === 'bank2') mapKey = 'bank';

            var recType = cfg[mapKey] || 'transfer';
            var doRecon = cfg['recon' + mapKey.charAt(0).toUpperCase() + mapKey.slice(1)];
            if (doRecon === undefined) doRecon = true;

            var recordName = pbShortName(fullTextToParse);
            var saved = null;

            // 1. ใส่เข้าตารางหลัก POS
            if (toTable) {
                var timeStr = new Date().toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
                saved = {
                    time: timeStr,
                    type: recType,
                    name: recordName,
                    amount: amount,
                    isEdited: false
                };
                // field เสริม (ไม่กระทบ renderTable/export/backup — ใช้แค่กันซ้ำข้ามช่องทางและ ✓✓)
                if (meta) {
                    saved.ts = now;
                    saved.via = meta.channel;
                    saved.channels = [meta.channel];
                    if (meta.eventId) saved.eventId = meta.eventId;
                    if (meta.sig) saved.sig = meta.sig;
                    if (meta.evTs) {
                        saved.evTs = meta.evTs;
                        // [ข้อ 6 feedback แอ๋ม] รายการที่กู้คืน (เน็ตหลุด/ปิดแอปแล้วเปิดใหม่ ฯลฯ) เดิม
                        // ใช้เวลาที่ "กู้คืนได้" (ตอนนี้) เป็นเวลาแสดงในตาราง ทำให้เทียบกับแอปธนาคาร
                        // ไม่ตรง → ถ้าห่างจากเวลาที่แจ้งเตือนเข้าจริง (evTs) เกิน 15 วิ ถือว่าเป็นรายการ
                        // กู้คืน ใช้เวลาจริงแทน + ติดป้าย "กู้คืน" ไว้ (ไม่เปลี่ยนรูปแบบ record เดิม
                        // แค่เพิ่ม field backfilled)
                        if (now - meta.evTs > 15000) {
                            saved.time = new Date(meta.evTs).toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
                            saved.backfilled = true;
                        }
                    }
                }
                records.push(saved);
                localStorage.setItem('posUltimateRecords', JSON.stringify(records));
                localStorage.setItem('posUltimateDate', new Date().toLocaleDateString('th-TH'));
                renderTable();
                refreshReconPosIfOpen();
                pbLog((meta && CHANNEL_ICONS[meta.channel] ? CHANNEL_ICONS[meta.channel] + ' ' : '') + '✅ บันทึก: +' + amount.toLocaleString('en-US') + ' ฿ (' + escapeHTML(recordName) + ')' + (saved.backfilled ? ' — กู้คืน' : ''), 'm');
                if (window.heroWindow && window.heroWindow.notifyMoneyIn) {
                    window.heroWindow.notifyMoneyIn(amount, recordName, recType);
                }
                if (typeof celebrateTransaction === 'function') celebrateTransaction(amount, { moneyIn: true });
            }

            // 2. ใส่เข้าช่องกระทบยอด
            if (doRecon && document.getElementById('reconModal') && document.getElementById('reconModal').style.display === 'flex') {
                var fieldId = null;
                if (srcType === 'paotang') fieldId = 'reconPaotang';
                // ช่อง 1 = ธนาคารกรุงเทพ (เงินเข้าธนาคารอื่นก็ลงช่องนี้), ช่อง 2 = ธนาคารของแม่มณี
                else if (srcType === 'maemanee') fieldId = 'reconBank2';
                else fieldId = 'reconBank1';

                var el = document.getElementById(fieldId);
                if (el) {
                    var oldVal = parseFloat(el.value) || 0;
                    var newVal = oldVal + amount;
                    el.value = newVal;
                    calcRecon();
                    el.style.background = '#dcfce7';
                    el.style.borderColor = '#16a34a';
                    setTimeout(function() { el.style.background = ''; el.style.borderColor = ''; }, 900);
                    pbLog('📱 กระทบยอด: +' + amount.toLocaleString('en-US') + ' ฿ → ' + fieldId, 'i');
                }
            }
            return saved;
        }

        // [FIX #10] keyword เงินเข้า — แยกออกมาใช้ร่วมกันทุกช่องทาง (Pushbullet / Firebase / วงเน็ต)
        var MONEY_KEYWORDS = ['เงินเข้า','รับโอน','เงินโอน','received','transfer','เข้า','รับเงิน','ได้รับ',
                  'top-up','เติมเงิน','คืนเงิน','money received','incoming',
                  'เงินโอนเข้า','โอนเงินเข้า','รับชำระ','ชำระเงิน','promptpay','พร้อมเพย์',
                  'สำเร็จ','โอนเงิน','ยอดเงิน','เงินโอนเข้าบัญชี','ชำระ','รับ',
                  'deposit','credit','payment','transaction'];
        // แจ้งเตือนโฆษณา/โปรโมชันจากแอปธนาคาร (เช่น "รับสิทธิ์ส่วนลด 50 บาท...") มีคำว่า "รับ" + "บาท"
        // เลยหลุด keyword ด้านบนแล้วถูกบันทึกเป็นเงินโอนเข้า — เจอตอนแคชเชียร์ทดลองใช้ จึงตัดทิ้งก่อน
        // ยกเว้นข้อความมีคำที่ยืนยันว่าเป็นเงินโอนเข้าจริง (กันเงินเข้าจริงที่บังเอิญมีคำพวกนี้ในบันทึกช่วยจำหลุดหาย)
        var AD_KEYWORDS = ['ส่วนลด','รับสิทธิ์','รับสิทธิ','สิทธิพิเศษ','โปรโมชั่น','โปรโมชัน','โปรฯ','แคชแบ็ก','แคชแบ็ค',
                  'เงินคืน','คูปอง','คะแนนสะสม','พอยท์','ลุ้นรับ','ลุ้นรางวัล','แจกฟรี','ฟรี!','สินเชื่อ','ผ่อน 0',
                  'ดอกเบี้ยพิเศษ','สมัครเลย','ดาวน์โหลด','อัปเดตแอป','อัพเดทแอป',
                  'cashback','coupon','promotion','promo','discount','reward','points'];
        var STRONG_MONEY_IN = ['เงินเข้า','รับโอน','เงินโอนเข้า','โอนเงินเข้า','ผู้โอน','received from','transfer from','money received'];
        function isAdNotification(full) {
            var t = (full || '').toLowerCase();
            var hasAd = AD_KEYWORDS.some(function(k) { return t.indexOf(k) > -1; });
            if (!hasAd) return false;
            return !STRONG_MONEY_IN.some(function(k) { return t.indexOf(k) > -1; });
        }

        function isMoneyNotification(full) {
            var t = (full || '').toLowerCase();
            if (isAdNotification(t)) return false;
            for (var i = 0; i < MONEY_KEYWORDS.length; i++) {
                if (t.indexOf(MONEY_KEYWORDS[i]) > -1) return true;
            }
            return false;
        }

        // ==========================================
        // [FIX #10] handlePbPush — [FIX] เพิ่ม keyword + ใช้ appName
        // ==========================================
        function handlePbPush(push) {
            // [BACKFILL] iden ถาวร กันนับซ้ำระหว่าง realtime กับ poll backfill (ถ้าไม่มี iden
            // ให้ผ่านไปพึ่ง signature-dedup 3 วิใน pbInject แทน)
            if (push.iden && isPushProcessed(push.iden)) {
                pbLog('⏭️ ข้าม (ประมวลผลแล้ว): ' + push.iden, 'i');
                return;
            }

            try {
                var title = push.title || '';
                var body = push.body || '';
                // [FIX] ดึงชื่อแอปที่ส่งแจ้งเตือนมาด้วย!
                var appName = push.application_name || push.app_name || '';

                pbLog('---', 'i');
                pbLog('🔗 APP: ' + escapeHTML(appName), 'i');

                // ตรวจ keyword / ยอด / แหล่งที่มา / กันซ้ำข้ามช่องทาง ใช้ร่วมกับ Firebase + วงเน็ต (ส่วนที่ 12)
                ingestMoneyEvent({
                    channel: 'pb',
                    id: push.iden || null,
                    eventId: '',
                    title: title,
                    body: body,
                    app: appName,
                    ts: push.created ? Math.round(push.created * 1000) : Date.now()
                });
            } finally {
                // [BACKFILL] ประทับ iden ว่า "ประมวลผลแล้ว" ไม่ว่าผลจะเป็นบันทึกสำเร็จหรือ skip/fail
                // ก็ตาม กัน poll รอบถัดไปดึง push เดิมมาพยายามซ้ำอีกไม่รู้จบ
                if (push.iden) markPushProcessed(push.iden);
            }
        }

        // ==========================================
        // [BACKFILL] pollMissedPushes — ตาข่ายนิรภัยสำรองจาก WS realtime
        // ดึง push ที่อาจตกหล่นจาก Pushbullet REST API มา backfill ผ่าน pipeline เดิม
        // (handlePbPush มี iden-dedup กันนับซ้ำกับของที่ WS realtime เก็บไปแล้วอยู่แล้ว)
        // ⚠️ ข้อจำกัด: /v2/pushes คืนเฉพาะ push ที่เก็บบนเซิร์ฟเวอร์ — แจ้งเตือนธนาคารที่ "mirror"
        // จากมือถือเป็น ephemeral ไม่ถูกเก็บ จึงกู้ไม่ได้ด้วย poll นี้ ช่วงที่ WS หลุด = รายการ mirror
        // ช่วงนั้นหายถาวร (ช่องทาง Firebase inbox เป็นตัวกู้ส่วนนี้แทน, ดู ส่วนที่ 12)
        // ==========================================
        function getPbPollTs() {
            var v = parseInt(localStorage.getItem('lastPbPollTs'), 10);
            // ครั้งแรกที่ไม่เคยมีค่า ให้เริ่มจาก "ตอนนี้" กันดึงประวัติเก่าย้อนหลังเป็นวันๆ มา replay
            if (!v) { v = Date.now(); localStorage.setItem('lastPbPollTs', String(v)); }
            return v;
        }

        function pollMissedPushes() {
            if (!pbToken || !window.heroWindow || !window.heroWindow.pollMissedPushes) return;
            var sinceTs = getPbPollTs() / 1000; // Pushbullet API ใช้หน่วยวินาที (epoch)
            window.heroWindow.pollMissedPushes(pbToken, sinceTs).then(function(res) {
                if (!res || !res.success) {
                    if (res && res.reason) pbLog('[POLL] เช็คย้อนหลังไม่สำเร็จ: ' + res.reason, 'w');
                    return;
                }
                var pushes = (res.pushes || []).filter(function(p) { return p.active !== false; });
                pushes.sort(function(a, b) { return (a.created || 0) - (b.created || 0); });
                pbLog('[POLL] เช็คย้อนหลัง: พบ ' + pushes.length + ' รายการ', 'i');
                pushes.forEach(function(p) { handlePbPush(p); });
                localStorage.setItem('lastPbPollTs', String(Date.now()));
            }).catch(function(e) {
                pbLog('[POLL] error: ' + e.message, 'e');
            });
        }

        setInterval(pollMissedPushes, 2 * 60 * 1000); // เช็คย้อนหลังทุก 2 นาทีเป็นพื้นฐาน

        // ==========================================
        // ส่วนที่ 12: 📥 INBOX — ช่องทางรับเงินเข้า + ช่วงหลุด (inboxGaps)
        // ==========================================
        // "ช่องทางหลัก" คือช่องทางที่ถ้าหลุดแล้วเราต้องสนใจว่ารายการช่วงนั้นหายไหม เก็บช่วงหลุด
        // (start → end) ไว้ใน localStorage 'inboxGaps' (สูงสุด 20) — หลังต่อกลับได้:
        //   - ช่องทางกู้ของค้างได้ (Firebase ดึงสำเร็จ) → ลบช่วงนั้นทิ้ง ไม่ต้องเตือน
        //   - กู้ไม่ได้ (Pushbullet mirror) และไม่มีช่องทางอื่นทำงานคลุมช่วงนั้น → แถบเตือนให้ไปเช็คแอปธนาคาร
        var CHANNEL_ICONS = { fb: '☁️', lan: '📶', pb: '🔗', app: '📱' };
        var CHANNEL_NAMES = { fb: 'Firebase', lan: 'วงเน็ต', pb: 'Pushbullet', app: 'แอป POS Relay' };
        var INBOX_GAP_MIN_MS = 10 * 1000;   // หลุดสั้นกว่านี้ (reconnect ปกติ) ไม่นับเป็นช่วงหลุด
        var INBOX_ALIVE_TICK_MS = 30 * 1000; // บันทึก "ยังต่ออยู่" ไว้ เผื่อแอปถูกปิดไปทั้งตัว
        var appRelayState = 'unconfigured';  // จาก main.js relay:status (android-app LAN relay)

        var _inboxGaps = (function() {
            try { return JSON.parse(localStorage.getItem('inboxGaps')) || []; } catch(e) { return []; }
        })();
        function saveInboxGaps() {
            if (_inboxGaps.length > 20) _inboxGaps = _inboxGaps.slice(-20);
            localStorage.setItem('inboxGaps', JSON.stringify(_inboxGaps));
        }
        function openInboxGap() {
            for (var i = 0; i < _inboxGaps.length; i++) if (!_inboxGaps[i].end) return _inboxGaps[i];
            return null;
        }

        // ตั้งค่าช่องทาง (localStorage 'inboxConfig') — main.js เป็นคนต่อ Firebase/UDP ตามค่านี้
        var INBOX_DEFAULTS = { dbUrl: '', inboxKey: '', fbEnabled: false, lanEnabled: false, lanPort: 47800, pbEnabled: true };
        var inboxCfg = (function() {
            var c = {};
            try { c = JSON.parse(localStorage.getItem('inboxConfig')) || {}; } catch(e) { c = {}; }
            return Object.assign({}, INBOX_DEFAULTS, c);
        })();
        var inboxStatus = { fb: { enabled: false, state: 'off', heartbeatTs: 0 }, lan: { enabled: false } };

        function fbIsConfigured() {
            return !!(inboxCfg.fbEnabled && /^https:\/\//.test(inboxCfg.dbUrl) && /^[A-Za-z0-9_-]{32,}$/.test(inboxCfg.inboxKey));
        }
        function sendInboxConfig() {
            if (!window.heroWindow || !window.heroWindow.setInboxConfig) return;
            window.heroWindow.setInboxConfig({
                dbUrl: inboxCfg.dbUrl, inboxKey: inboxCfg.inboxKey, fbEnabled: inboxCfg.fbEnabled,
                lastKey: localStorage.getItem('fbInboxLastKey') || '',
                lanEnabled: inboxCfg.lanEnabled, lanPort: inboxCfg.lanPort
            });
        }

        function inboxPrimaryChannel() {
            if (fbIsConfigured()) return 'fb';
            if (pbToken && inboxCfg.pbEnabled) return 'pb';
            return null;
        }
        var INBOX_HEARD_WINDOW_MS = 12 * 60 * 1000; // heartbeat ทุก 5 นาที เผื่อพลาด 1 รอบ
        function lanLastHeard() {
            var l = inboxStatus.lan || {};
            return Math.max(l.lastPacketAt || 0, l.heartbeatAt || 0);
        }
        function inboxChannelIsUp(ch) {
            if (ch === 'fb') return inboxStatus.fb.state === 'ok';
            if (ch === 'lan') return !!(inboxStatus.lan && inboxStatus.lan.enabled && inboxStatus.lan.bound && (Date.now() - lanLastHeard()) < INBOX_HEARD_WINDOW_MS);
            if (ch === 'pb') return pbWsState === 'ok';
            if (ch === 'app') return appRelayState === 'ok';
            return false;
        }
        // มีช่องทางอื่น (ที่ไม่ใช่ตัวที่หลุด) ทำงานอยู่ไหม — ใช้ตัดสินว่าช่วงหลุดถูก "คลุม" แล้ว
        function inboxOtherChannelAlive(except) {
            return ['fb', 'lan', 'pb', 'app'].some(function(ch) { return ch !== except && inboxChannelIsUp(ch); });
        }

        function inboxOnChannelDown(ch) {
            if (ch !== inboxPrimaryChannel() || openInboxGap()) return;
            _inboxGaps.push({ start: Date.now(), end: null, channel: ch, covered: inboxOtherChannelAlive(ch) });
            saveInboxGaps();
        }

        // recovered=true: ช่องทางนี้ดึงของค้างช่วงหลุดได้ครบแล้ว (Firebase) → ไม่ต้องเตือน
        function inboxOnChannelUp(ch, recovered) {
            var g = openInboxGap();
            if (!g || ch !== inboxPrimaryChannel()) return;
            g.end = Date.now();
            if (g.end - g.start < INBOX_GAP_MIN_MS) {
                _inboxGaps.splice(_inboxGaps.indexOf(g), 1);
            } else if (recovered) {
                pbLog(CHANNEL_ICONS[ch] + ' กู้รายการช่วงหลุด ' + fmtGapTime(g.start) + '–' + fmtGapTime(g.end) + ' ครบแล้ว', 'm');
                _inboxGaps.splice(_inboxGaps.indexOf(g), 1);
            } else if (g.covered && inboxOtherChannelAlive(ch)) {
                pbLog('ℹ️ ' + CHANNEL_ICONS[ch] + ' หลุดช่วง ' + fmtGapTime(g.start) + '–' + fmtGapTime(g.end) + ' แต่มีช่องทางอื่นทำงานคลุมอยู่', 'i');
                _inboxGaps.splice(_inboxGaps.indexOf(g), 1);
            }
            saveInboxGaps();
            renderInboxGapBar();
        }

        function fmtGapTime(ts) {
            var d = new Date(ts);
            var hm = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
            if (d.toDateString() !== new Date().toDateString()) hm = d.getDate() + '/' + (d.getMonth() + 1) + ' ' + hm;
            return hm;
        }

        function renderInboxGapBar() {
            var bar = document.getElementById('inboxGapBar');
            if (!bar) return;
            var show = _inboxGaps.filter(function(g) { return g.end; });
            if (!show.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
            bar.innerHTML = show.map(function(g) {
                return '<div class="gap-item"><span>⚠️ ' + fmtGapTime(g.start) + '–' + fmtGapTime(g.end) +
                    ' ขาดการเชื่อมต่อ ตรวจยอดในแอปธนาคารช่วงนี้</span>' +
                    '<button class="gap-ok" title="ตรวจแล้ว" onclick="dismissInboxGap(' + g.start + ')">✓</button></div>';
            }).join('');
            bar.style.display = 'block';
        }

        function dismissInboxGap(start) {
            _inboxGaps = _inboxGaps.filter(function(g) { return g.start !== start; });
            saveInboxGaps();
            renderInboxGapBar();
        }

        // แอปถูกปิดไปทั้งตัว (ปิดเครื่อง/ไฟดับ) ก็คือช่วงหลุดเหมือนกัน — จด "ยังต่ออยู่" ทุก 30 วิ
        // ตอนเปิดแอปใหม่ถ้าห่างเกิน 1 นาที เปิดช่วงหลุดตั้งแต่ตอนนั้นไว้ รอช่องทางหลักต่อได้แล้วค่อยตัดสิน
        setInterval(function() {
            var ch = inboxPrimaryChannel();
            if (ch && inboxChannelIsUp(ch) && !openInboxGap()) localStorage.setItem('inboxLastAliveTs', String(Date.now()));
        }, INBOX_ALIVE_TICK_MS);

        document.addEventListener('DOMContentLoaded', function() {
            var lastAlive = parseInt(localStorage.getItem('inboxLastAliveTs'), 10);
            var ch = inboxPrimaryChannel();
            if (!openInboxGap() && ch && lastAlive && (Date.now() - lastAlive) > 60 * 1000) {
                _inboxGaps.push({ start: lastAlive, end: null, channel: ch, covered: false });
                saveInboxGaps();
            }
            renderInboxGapBar();
        });

        // ------------------------------------------
        // inboxSeen — กันซ้ำระดับ 1 ด้วย eventId (Firebase กับวงเน็ตมาจาก macro เดียวกัน eventId เดียวกัน)
        // { [eventId]: { at, recordTs, channels: [...] } } เก็บย้อนหลัง 500 รายการ
        // ------------------------------------------
        var _inboxSeen = (function() {
            try { return JSON.parse(localStorage.getItem('inboxSeen')) || {}; } catch(e) { return {}; }
        })();
        function saveInboxSeen() {
            var ids = Object.keys(_inboxSeen);
            if (ids.length > 500) {
                ids.sort(function(a, b) { return (_inboxSeen[a].at || 0) - (_inboxSeen[b].at || 0); });
                ids.slice(0, ids.length - 500).forEach(function(id) { delete _inboxSeen[id]; });
            }
            localStorage.setItem('inboxSeen', JSON.stringify(_inboxSeen));
        }
        function findRecordByTs(ts) {
            if (!ts) return null;
            for (var i = records.length - 1; i >= 0; i--) if (records[i].ts === ts) return records[i];
            return null;
        }
        // บันทึกว่ารายการนี้ได้รับการยืนยันจากช่องทาง ch ด้วย (สำหรับ ✓✓ ในตาราง)
        function addRecordChannel(rec, ch) {
            if (!rec) return;
            if (!rec.channels) rec.channels = rec.via ? [rec.via] : [];
            if (rec.channels.indexOf(ch) > -1) return;
            rec.channels.push(ch);
            localStorage.setItem('posUltimateRecords', JSON.stringify(records));
            renderTable();
        }

        // ------------------------------------------
        // กันซ้ำระดับ 2 — Pushbullet เทียบกับ Firebase/วงเน็ต (ไม่มี eventId ร่วมกัน)
        // signature = ยอด + ข้อความ (ตัดช่องว่างซ้ำ, ตัวเล็ก) และเวลาแจ้งเตือนห่างกันไม่เกิน 3 นาที
        // record หนึ่ง "จับคู่ได้ 1 ครั้งต่อช่องทาง" → โอนจริง 2 ครั้ง ยอด/ข้อความเหมือนกัน ยังได้ครบ 2 รายการ
        // (เทียบเวลาของแจ้งเตือนเอง ไม่ใช่เวลาที่คอมได้รับ — Firebase อาจดึงของค้างมาทีหลังหลายนาที)
        // ------------------------------------------
        var INBOX_TWIN_WINDOW_MS = 3 * 60 * 1000;
        function normalizeInboxText(s) {
            return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        }
        function findCrossChannelTwin(ch, sig, evTs) {
            for (var i = records.length - 1; i >= 0; i--) {
                var r = records[i];
                if (!r.sig || r.sig !== sig) continue;
                if (Math.abs((r.evTs || r.ts || 0) - evTs) > INBOX_TWIN_WINDOW_MS) continue;
                var chans = r.channels || (r.via ? [r.via] : []);
                if (chans.indexOf(ch) > -1) continue; // เคยจับคู่กับช่องทางนี้แล้ว
                if (ch === 'pb') {
                    if (chans.indexOf('fb') < 0 && chans.indexOf('lan') < 0) continue;
                } else {
                    // Firebase/วงเน็ต จับคู่ได้เฉพาะรายการจาก Pushbullet ที่ยังไม่มี eventId
                    // (eventId ต่างกัน = macro คนละครั้ง = เงินเข้าคนละรายการ)
                    if (chans.indexOf('pb') < 0 || r.eventId) continue;
                }
                return r;
            }
            return null;
        }

        // ==========================================
        // ingestMoneyEvent — จุดรวมทุกช่องทาง: { channel, id, eventId, title, body, app, ts }
        // ตรวจ keyword → extractMoney → detectSource (โค้ดเดิม) → กันซ้ำ → pbInject
        // ==========================================
        function ingestMoneyEvent(evt) {
            if (!evt) return;
            var ch = evt.channel;
            var icon = CHANNEL_ICONS[ch] || '';
            try {
                var title = String(evt.title || '');
                var body = String(evt.body || '');
                var appName = String(evt.app || '');

                // ระดับ 1: eventId ตรงกัน = เหตุการณ์เดียวกันแน่นอน ไม่บันทึกซ้ำ แค่เพิ่มช่องทางที่ยืนยัน
                if (evt.eventId && _inboxSeen[evt.eventId]) {
                    var seen = _inboxSeen[evt.eventId];
                    if (seen.channels.indexOf(ch) < 0) { seen.channels.push(ch); saveInboxSeen(); }
                    addRecordChannel(findRecordByTs(seen.recordTs), ch);
                    pbLog(icon + ' ⏭️ ซ้ำกับรายการที่รับแล้ว (eventId ' + escapeHTML(evt.eventId) + ')', 'i');
                    return;
                }
                if (evt.eventId) { _inboxSeen[evt.eventId] = { at: Date.now(), recordTs: null, channels: [ch] }; saveInboxSeen(); }

                pbLog(icon + ' [RECV] ' + escapeHTML(title.substring(0, 30)) + ' | ' + escapeHTML(body.substring(0, 50)), 'i');

                var full = title + ' ' + body + ' ' + appName;

                // โหมดทดสอบ: title ขึ้นต้น TEST (ทุกช่องทาง) หรือกดปุ่ม "โหมดทดสอบ" ไว้ → แสดงผลอย่างเดียว ไม่บันทึก
                if (/^\s*TEST/i.test(title) || inboxTestArmed) {
                    disarmInboxTestMode();
                    var tAmt = isMoneyNotification(full) ? extractMoney(full) : null;
                    var tSrc = detectSource(full) || 'fallback';
                    var tName = pbShortName((body + ' ' + title).replace(/\n/g, ' '));
                    var tGroupLabel = GROUP_LABELS[tSrc] || tSrc;
                    pbLog('🧪 ' + icon + ' ทดสอบ ' + escapeHTML(CHANNEL_NAMES[ch] || ch) + ': ยอด ' + (tAmt ? tAmt.toLocaleString('en-US') + ' ฿' : 'อ่านไม่ได้') +
                          ' · แหล่ง ' + escapeHTML(tGroupLabel) + ' · ชื่อ "' + escapeHTML(tName) + '" (ไม่บันทึกลงตาราง)', 'm');
                    // [ข้อ 10] แสดงผลใกล้ปุ่มด้วย ไม่ใช่แค่ใน log ที่อยู่ไกล
                    setInboxTestResult(tAmt
                        ? ('✅ ได้รับ ' + tAmt.toLocaleString('en-US') + ' ฿ จาก ' + escapeHTML(tName) + ' ทาง ' + icon + ' ' + escapeHTML(CHANNEL_NAMES[ch] || ch) + ' (' + escapeHTML(tGroupLabel) + ') — ไม่บันทึก')
                        : ('⚠️ ทดสอบทาง ' + icon + ' ' + escapeHTML(CHANNEL_NAMES[ch] || ch) + ' สำเร็จ แต่อ่านยอดเงินไม่ได้ — ไม่บันทึก'));
                    return;
                }

                if (isAdNotification(full)) { pbLog(icon + ' ⏭️ ข้ามแจ้งเตือนโฆษณา/โปรโมชัน: ' + escapeHTML(full.substring(0, 60)), 'i'); return; }
                if (!isMoneyNotification(full)) { pbLog(icon + ' [SKIP] ไม่ใช่แจ้งเตือนเงินเข้า', 'i'); return; }
                var amt = extractMoney(full);
                if (!amt) { pbLog(icon + ' [FAIL] อ่านยอดไม่ได้: ' + escapeHTML(full.substring(0, 80)), 'e'); return; }
                var src = detectSource(full);
                if (!src) { src = 'fallback'; pbLog(icon + ' [WARN] ไม่รู้แหล่งที่มา → ใช้ fallback', 'w'); }

                // ระดับ 2: Pushbullet ไม่มี eventId ร่วมกับ macro → เทียบ ยอด + ข้อความ ภายใน 3 นาที
                var sig = amt + '_' + normalizeInboxText(title + ' ' + body);
                var evTs = Number(evt.ts) || Date.now();
                var twin = findCrossChannelTwin(ch, sig, evTs);
                if (twin) {
                    if (ch !== 'pb' && evt.eventId) {
                        twin.eventId = evt.eventId;
                        _inboxSeen[evt.eventId].recordTs = twin.ts;
                        saveInboxSeen();
                    }
                    addRecordChannel(twin, ch);
                    pbLog(icon + ' 🔁 ตรงกับรายการ +' + amt.toLocaleString('en-US') + ' ฿ ที่รับจาก ' +
                          escapeHTML(twin.channels.filter(function(c) { return c !== ch; }).map(function(c) { return CHANNEL_NAMES[c] || c; }).join(' + ')) +
                          ' แล้ว (ไม่บันทึกซ้ำ)', 'i');
                    return;
                }

                var rec = pbInject(amt, src, title, body, { channel: ch, eventId: evt.eventId || '', sig: sig, evTs: evTs });
                if (rec && evt.eventId) { _inboxSeen[evt.eventId].recordTs = rec.ts; saveInboxSeen(); }
            } finally {
                // Firebase: ยืนยันว่าประมวลผลแล้ว → main เลื่อน cursor, ครั้งหน้าไม่ดึงซ้ำ
                if (ch === 'fb' && evt.id) {
                    var last = localStorage.getItem('fbInboxLastKey') || '';
                    if (evt.id > last) localStorage.setItem('fbInboxLastKey', evt.id);
                    if (window.heroWindow && window.heroWindow.inboxAck) window.heroWindow.inboxAck(evt.id);
                }
            }
        }

        // ------------------------------------------
        // หน้าตั้งค่า "📥 ช่องทางรับเงินเข้า" (index.html #inboxBox)
        // ------------------------------------------
        function loadInboxForm() {
            var set = function(id, prop, v) { var el = document.getElementById(id); if (el) el[prop] = v; };
            set('inboxFbEnabled', 'checked', !!inboxCfg.fbEnabled);
            set('inboxDbUrl', 'value', inboxCfg.dbUrl || '');
            set('inboxKey', 'value', inboxCfg.inboxKey || '');
            set('inboxLanEnabled', 'checked', !!inboxCfg.lanEnabled);
            set('inboxLanPort', 'value', inboxCfg.lanPort || 47800);
            set('inboxPbEnabled', 'checked', inboxCfg.pbEnabled !== false);
            var urlErrEl = document.getElementById('inboxFbUrlErr');
            var keyErrEl = document.getElementById('inboxFbKeyErr');
            var urlErr = inboxUrlProblem(inboxCfg.dbUrl || '');
            var keyErr = inboxKeyProblem(inboxCfg.inboxKey || '');
            if (urlErrEl) urlErrEl.textContent = urlErr ? ('Database URL ' + urlErr) : '';
            if (keyErrEl) keyErrEl.textContent = keyErr;
        }

        // [ข้อ 11] เดิมพิมพ์ Database URL ผิด (เช่นวาง URL ซ้อนกัน 2 อันจนมีช่องว่างตรงกลาง) แอปบันทึก
        // ไปเลยเงียบๆ ไม่เตือน ต้องไปไล่ดู log เอง — ตรวจให้ละเอียดขึ้น (มีช่องว่าง/รูปแบบผิด) แล้วโชว์
        // ข้อความเตือนติดกับช่องกรอกเลย (ยังคงบันทึกค่าไว้ตามเดิม เผื่อร้านแก้ต่อจากตรงนี้)
        function inboxUrlProblem(url) {
            if (!url) return '';
            if (/\s/.test(url)) return '❌ มีช่องว่างอยู่ตรงกลาง URL (อาจวาง URL ซ้อนกัน 2 อัน) — ลบส่วนเกินออก';
            if (!/^https:\/\//.test(url)) return '❌ ต้องขึ้นต้นด้วย https://';
            return '';
        }
        function inboxKeyProblem(key) {
            if (!key) return '';
            if (/\s/.test(key)) return '❌ Key มีช่องว่างอยู่ — คัดลอกใหม่ให้ครบ';
            if (!/^[A-Za-z0-9_-]{32,}$/.test(key)) return '❌ ต้องยาว 32 ตัวขึ้นไป (a-z A-Z 0-9 _ -) — กด 🎲 เพื่อสุ่ม';
            return '';
        }
        function saveInboxSettings() {
            var val = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
            var chk = function(id) { var el = document.getElementById(id); return !!(el && el.checked); };
            var next = {
                dbUrl: val('inboxDbUrl').replace(/\/+$/, ''),
                inboxKey: val('inboxKey'),
                fbEnabled: chk('inboxFbEnabled'),
                lanEnabled: chk('inboxLanEnabled'),
                lanPort: parseInt(val('inboxLanPort'), 10) || 47800,
                pbEnabled: chk('inboxPbEnabled')
            };
            var urlErr = inboxUrlProblem(next.dbUrl);
            var keyErr = inboxKeyProblem(next.inboxKey);
            var urlErrEl = document.getElementById('inboxFbUrlErr');
            var keyErrEl = document.getElementById('inboxFbKeyErr');
            if (urlErrEl) urlErrEl.textContent = urlErr ? ('Database URL ' + urlErr) : '';
            if (keyErrEl) keyErrEl.textContent = keyErr;
            if (urlErr) pbLog('☁️ Database URL ' + urlErr, 'e');
            if (keyErr) pbLog('☁️ Inbox Key ' + keyErr, 'e');
            if (next.lanPort < 1024 || next.lanPort > 65535) { next.lanPort = 47800; pbLog('📶 พอร์ตต้องอยู่ระหว่าง 1024–65535 → ใช้ 47800', 'w'); }
            // เปลี่ยน URL/Key = inbox คนละที่ → เริ่ม cursor ใหม่ (ตั้งเป็น "ตอนนี้" ตอนต่อครั้งแรก)
            if (next.dbUrl !== inboxCfg.dbUrl || next.inboxKey !== inboxCfg.inboxKey) localStorage.removeItem('fbInboxLastKey');
            var pbChanged = next.pbEnabled !== inboxCfg.pbEnabled;
            inboxCfg = next;
            localStorage.setItem('inboxConfig', JSON.stringify(inboxCfg));
            sendInboxConfig();
            if (pbChanged) {
                if (!inboxCfg.pbEnabled) { disconnectPushbullet(); setPbWsStatus('⏸️ ปิดอยู่ (ตั้งค่าใน 📥 ช่องทางรับเงินเข้า)', ''); }
                else if (pbToken) connectPushbullet();
            }
            updateCombinedLed();
            checkLanFirewall();
        }

        function genInboxKey() {
            if (inboxCfg.inboxKey && !confirm('สุ่ม Inbox Key ใหม่?\n\nต้องไปแก้ key ใน MacroDroid บนมือถือให้ตรงกันด้วย ไม่งั้นจะรับเงินเข้าไม่ได้')) return;
            var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            var bytes = new Uint8Array(40);
            crypto.getRandomValues(bytes);
            var key = '';
            for (var i = 0; i < bytes.length; i++) key += chars.charAt(bytes[i] % chars.length);
            document.getElementById('inboxKey').value = key;
            saveInboxSettings();
        }

        // [ข้อ 13] ปุ่ม 📋 คัดลอกได้จริงอยู่แล้ว แต่ไม่มีอะไรบอกบนจอ — ข้อความ "คัดลอกแล้ว" เดิมไปโผล่
        // ใน pbLog ที่อยู่ไกลจากปุ่มมาก (บางทีอยู่ใต้ modal ที่เปิดซ้อนอยู่) → เปลี่ยนปุ่มเป็น ✓ ชั่วครู่แทน
        function copyInboxText(text, btn) {
            if (!text) return;
            var done = function() { pbLog('📋 คัดลอกแล้ว', 'i'); flashCopyButton(btn); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function() { copyInboxTextFallback(text); done(); });
            } else { copyInboxTextFallback(text); done(); }
        }
        function flashCopyButton(btn) {
            if (!btn) return;
            if (btn._copyTimer) clearTimeout(btn._copyTimer);
            if (btn.dataset.origLabel === undefined) btn.dataset.origLabel = btn.textContent;
            btn.textContent = '✓ คัดลอกแล้ว';
            btn.classList.add('copied');
            btn._copyTimer = setTimeout(function() {
                btn.textContent = btn.dataset.origLabel;
                btn.classList.remove('copied');
            }, 1400);
        }
        function copyInboxTextFallback(text) {
            var ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch(e) {}
            document.body.removeChild(ta);
        }

        function checkLanFirewall() {
            var el = document.getElementById('inboxFwStatus');
            if (!el || !window.heroWindow || !window.heroWindow.firewallCheck) return;
            window.heroWindow.firewallCheck().then(function(r) {
                if (!r || !r.ok) { el.textContent = 'ตรวจไม่ได้' + (r && r.reason ? ' (' + r.reason + ')' : ''); return; }
                var port = String(inboxCfg.lanPort || 47800);
                if (!r.exists) el.textContent = '❌ ยังไม่มีกฎ — กด 🛡️ อนุญาตไฟร์วอลล์';
                else if (r.ports.indexOf(port) < 0) el.textContent = '⚠️ มีกฎแต่เป็นพอร์ต ' + r.ports.join(',') + ' — กด 🛡️ ใหม่';
                else el.textContent = '✅ อนุญาตพอร์ต ' + port + ' แล้ว (ทุกประเภทเครือข่าย)';
            });
        }

        function addLanFirewallRule() {
            if (!window.heroWindow || !window.heroWindow.firewallAdd) return;
            var el = document.getElementById('inboxFwStatus');
            if (el) el.textContent = '⏳ รอยืนยันสิทธิ์ admin...';
            window.heroWindow.firewallAdd(inboxCfg.lanPort || 47800).then(function(r) {
                if (r && r.ok) pbLog('🛡️ เพิ่มกฎไฟร์วอลล์ UDP ' + (inboxCfg.lanPort || 47800) + ' แล้ว', 'm');
                else pbLog('🛡️ เพิ่มกฎไฟร์วอลล์ไม่สำเร็จ: ' + escapeHTML((r && r.reason) || ''), 'e');
                checkLanFirewall();
            });
        }

        function renderLanIps() {
            var el = document.getElementById('inboxLanIps');
            if (!el) return;
            var ips = (inboxStatus.lan && inboxStatus.lan.ips) || [];
            el.textContent = ips.length ? ips.join(', ') : 'ไม่พบ (ยังไม่ได้ต่อเครือข่าย)';
        }

        function openMacroInfoModal() {
            var body = document.getElementById('macroInfoBody');
            if (!body) return;
            var url = inboxCfg.dbUrl || 'https://<Database URL>';
            var key = inboxCfg.inboxKey || '<Inbox Key>';
            var port = inboxCfg.lanPort || 47800;
            var items = [
                ['① HTTP POST (Firebase) — URL', url + '/pos_hero_inbox/' + key + '/events.json'],
                ['① Body (JSON)', '{"eventId":"[lv=eventId]","title":"[not_title]","text":"[notification]","app":"[not_app_name]","pkg":"[not_app_package]","ts":{".sv":"timestamp"},"via":"fb"}'],
                ['② UDP — ปลายทาง', '255.255.255.255 : ' + port],
                ['② UDP — ข้อความ (JSON)', '{"k":"' + key.slice(0, 8) + '","eventId":"[lv=eventId]","title":"[not_title]","text":"[notification]","app":"[not_app_name]","ts":[system_time]}'],
                ['③ Heartbeat ทุก 5 นาที — HTTP PUT', url + '/pos_hero_inbox/' + key + '/heartbeat.json'],
                ['③ Heartbeat — Body', '{"ts":{".sv":"timestamp"},"battery":[battery]}'],
                ['③ Heartbeat — UDP', '{"k":"' + key.slice(0, 8) + '","hb":1,"battery":[battery]}']
            ];
            body.innerHTML = '<div class="inbox-note" style="margin-bottom:8px;">ตัวแปรใน [ ] คือ Magic Text ของ MacroDroid — เลือกจากปุ่ม "…" ในแอปให้ตรงกับเวอร์ชันที่ใช้ · คู่มือเต็ม: ไฟล์ docs/macrodroid-setup.md ในโฟลเดอร์ติดตั้งโปรแกรม (ไม่ใช่ลิงก์ กดจากตรงนี้ไม่ได้)</div>' +
                items.map(function(it, i) {
                    return '<div class="macro-label"><span>' + escapeHTML(it[0]) + '</span><button class="pb-btn" style="background:#475569; flex:0 0 auto; padding:3px 8px;" onclick="copyMacroItem(' + i + ', this)">📋</button></div><pre>' + escapeHTML(it[1]) + '</pre>';
                }).join('');
            window._macroItems = items;
            document.getElementById('macroInfoModal').style.display = 'flex';
        }
        function copyMacroItem(i, btn) { if (window._macroItems && window._macroItems[i]) copyInboxText(window._macroItems[i][1], btn); }
        function closeMacroInfoModal() { document.getElementById('macroInfoModal').style.display = 'none'; }

        document.addEventListener('DOMContentLoaded', function() {
            loadInboxForm();
            checkLanFirewall();
            if (!inboxCfg.pbEnabled) setPbWsStatus('⏸️ ปิดอยู่ (ตั้งค่าใน 📥 ช่องทางรับเงินเข้า)', '');
        });

        // ------------------------------------------
        // โหมดทดสอบ — รับ event ถัดไป (ช่องทางไหนก็ได้) แล้วแสดงผลใน log โดยไม่บันทึกลงตาราง
        // ------------------------------------------
        var inboxTestArmed = false;
        var inboxTestTimer = null;
        // [ข้อ 10 feedback แอ๋ม] ผลโหมดทดสอบเดิมโผล่แต่ใน pbLog (สูงกว่าปุ่มราว 400px คนกดไม่เห็น) —
        // ใช้กล่องเล็กๆ ใต้ปุ่มเอง (#inboxTestResult) โชว์ผลทันที ควบคู่กับ pbLog (ยังเก็บไว้ debug)
        function setInboxTestResult(html) {
            var el = document.getElementById('inboxTestResult');
            if (el) el.innerHTML = html;
        }
        function armInboxTestMode() {
            inboxTestArmed = true;
            if (inboxTestTimer) clearTimeout(inboxTestTimer);
            inboxTestTimer = setTimeout(function() {
                if (inboxTestArmed) { disarmInboxTestMode(); pbLog('🧪 หมดเวลาโหมดทดสอบ (ไม่มีแจ้งเตือนเข้ามาใน 5 นาที)', 'w'); setInboxTestResult('⌛ หมดเวลา — ไม่มีแจ้งเตือนเข้ามาใน 5 นาที'); }
            }, 5 * 60 * 1000);
            pbLog('🧪 โหมดทดสอบ: รอแจ้งเตือนถัดไป — จะแสดงผลอย่างเดียว ไม่บันทึกลงตาราง', 'w');
            setInboxTestResult('⏳ รอแจ้งเตือนทดสอบ... (ส่งจากมือถือได้เลย)');
            var b = document.getElementById('btnInboxTest');
            if (b) b.textContent = '🧪 รอแจ้งเตือนทดสอบ...';
        }
        function disarmInboxTestMode() {
            inboxTestArmed = false;
            if (inboxTestTimer) { clearTimeout(inboxTestTimer); inboxTestTimer = null; }
            var b = document.getElementById('btnInboxTest');
            if (b) b.textContent = '🧪 โหมดทดสอบ';
        }

        if (window.heroWindow && window.heroWindow.onInboxEvent) {
            window.heroWindow.onInboxEvent(ingestMoneyEvent);
            window.heroWindow.onInboxLog(function(m) { if (m) pbLog(m.msg, m.type); });
            window.heroWindow.onInboxCursor(function(c) {
                if (c && c.lastKey && c.lastKey > (localStorage.getItem('fbInboxLastKey') || '')) localStorage.setItem('fbInboxLastKey', c.lastKey);
            });
            window.heroWindow.onInboxBackfill(function(r) {
                if (!r) return;
                if (r.ok) {
                    if (r.count) pbLog('☁️ ดึงรายการค้างจาก Firebase: ' + r.count + ' รายการ', 'm');
                    inboxOnChannelUp('fb', true);
                } else {
                    pbLog('☁️ ดึงรายการค้างไม่สำเร็จ: ' + escapeHTML(r.reason || ''), 'w');
                }
            });
            window.heroWindow.onInboxStatus(function(s) {
                if (!s) return;
                var prev = inboxStatus.fb.state;
                inboxStatus = s;
                var now = s.fb.state;
                if (s.fb.enabled && now !== 'ok' && (prev === 'ok' || now === 'err')) inboxOnChannelDown('fb');
                updateCombinedLed();
                renderLanIps();
            });
        }
        document.addEventListener('DOMContentLoaded', sendInboxConfig);

        // ------------------------------------------
        // ไฟรวม (#pbLed / #miniPbLed) + ไฟแยกรายช่องทางในกล่องตั้งค่า
        //   🟢 Firebase ต่ออยู่ + heartbeat มือถือไม่เกิน 12 นาที
        //   🟡 Firebase ใช้ไม่ได้ แต่วงเน็ตได้ยินภายใน 12 นาที / Pushbullet ต่ออยู่ / แอป POS Relay ต่ออยู่
        //   🔴 ไม่มีช่องทางไหนทำงาน   ⚪ ยังไม่ได้ตั้งค่าช่องทางไหนเลย
        // ------------------------------------------
        function agoText(ts) {
            if (!ts) return 'ยังไม่เคยได้ยิน';
            var m = Math.floor((Date.now() - ts) / 60000);
            return m < 1 ? 'ได้ยินล่าสุดเมื่อครู่' : 'ได้ยินล่าสุด ' + m + ' นาทีก่อน';
        }
        function fbHeartbeatFresh() {
            var hb = inboxStatus.fb.heartbeatTs;
            return !!hb && (Date.now() - hb) < INBOX_HEARD_WINDOW_MS;
        }
        function channelLedStates() {
            var fb = inboxStatus.fb || {};
            var lan = inboxStatus.lan || {};
            var s = {};

            // [ข้อ 14] "เปิดใช้" (ติ๊ก) กับ "พร้อมทำงาน" (ตั้งค่าครบ) เป็นคนละเรื่อง — ติ๊กไว้แต่ยังกรอก
            // URL/Key ไม่ครบ ไม่ควรขึ้น "ปิดอยู่" เฉยๆ เดี๋ยวดูขัดกับติ๊กที่เปิดอยู่
            if (!inboxCfg.fbEnabled) s.fb = { cls: '', text: 'ปิดอยู่' };
            else if (!fbIsConfigured()) s.fb = { cls: '', text: 'ยังตั้งค่าไม่ครบ (ใส่ URL/Key ก่อน)' };
            else if (fb.state === 'ok' && fbHeartbeatFresh()) s.fb = { cls: 'ok', text: 'ต่ออยู่' + (fb.battery != null ? ' (แบตมือถือ ' + fb.battery + '%)' : '') };
            else if (fb.state === 'ok') s.fb = { cls: 'warn', text: 'ต่ออยู่ แต่มือถือดักจับเงียบ (heartbeat ' + (fb.heartbeatTs ? Math.floor((Date.now() - fb.heartbeatTs) / 60000) + ' นาทีก่อน' : 'ยังไม่เคยมา') + ')' };
            else if (fb.state === 'connecting') s.fb = { cls: 'warn', text: 'กำลังเชื่อมต่อ' };
            // [ข้อ 11] ติดเหตุผลที่แปลเป็นภาษาคนแล้ว (main.js's humanizeFbError) ต่อท้าย ไม่ใช่แค่ "หลุด" เฉยๆ
            else s.fb = { cls: 'err', text: 'เชื่อมต่อไม่ได้' + (fb.lastError ? ' — ' + fb.lastError : '') };

            if (!lan.enabled) s.lan = { cls: '', text: 'ปิดอยู่' };
            else if (lan.error) s.lan = { cls: 'err', text: 'เปิดรับไม่ได้ — ' + lan.error };
            else if (inboxChannelIsUp('lan')) s.lan = { cls: 'ok', text: agoText(lanLastHeard()) };
            else s.lan = { cls: 'warn', text: 'รอฟังพอร์ต ' + (lan.port || '') + ' — ' + agoText(lanLastHeard()) };

            // [ข้อ 14] เช่นเดียวกับ Firebase — ติ๊ก "เปิดใช้" ไว้แต่ยังไม่ได้ใส่ Token ไม่ควรขึ้น "ปิดอยู่"
            if (!inboxCfg.pbEnabled) s.pb = { cls: '', text: 'ปิดอยู่' };
            else if (!pbToken) s.pb = { cls: '', text: 'ยังไม่ได้ใส่ Token' };
            else if (pbWsState === 'ok') s.pb = { cls: 'ok', text: 'ต่ออยู่' };
            else if (pbWsState === 'connecting') s.pb = { cls: 'warn', text: 'กำลังเชื่อมต่อ' };
            else s.pb = { cls: 'err', text: 'หลุด' };

            if (appRelayState === 'ok') s.app = { cls: 'ok', text: 'ต่ออยู่' };
            else if (appRelayState === 'err') s.app = { cls: 'err', text: 'เงียบ' };
            else s.app = { cls: '', text: 'ไม่ได้ใช้' };
            return s;
        }

        var combinedLedState = '';
        var combinedErrSince = 0;
        var combinedLastAlertAt = 0;
        function updateCombinedLed() {
            if (typeof inboxStatus === 'undefined' || !inboxStatus) return;
            var s = channelLedStates();
            var fbWorking = s.fb.cls === 'ok';
            var backupWorking = inboxChannelIsUp('lan') || s.pb.cls === 'ok' || appRelayState === 'ok';
            var anyConfigured = s.fb.text !== 'ปิดอยู่' || s.lan.text !== 'ปิดอยู่' || s.pb.text !== 'ปิดอยู่' || appRelayState !== 'unconfigured';
            // [ข้อ 12 feedback แอ๋ม] เพิ่งตั้งค่า Firebase เสร็จ (มือถือยังไม่เคยส่ง heartbeat เลยสัก
            // ครั้ง) เดิมไฟรวมขึ้นแดงทันที ทั้งที่ Firebase เองต่อได้ปกติ แค่ยังไม่เคยได้ยินจากมือถือ —
            // ควรเป็นเหลือง/รอ ไม่ใช่แดง แต่ถ้าเคยได้ heartbeat มาก่อนแล้วเงียบไป (heartbeatTs > 0 แต่
            // เก่าเกิน 12 นาที) ยังต้องแดงเหมือนเดิม (ของจริงเสียกลางทาง ไม่ใช่แค่ยังไม่ได้ตั้งมือถือ)
            var fbNeverHeard = fbIsConfigured() && (inboxStatus.fb.state === 'ok' || inboxStatus.fb.state === 'connecting') && !inboxStatus.fb.heartbeatTs;
            var cls = fbWorking ? 'ok' : backupWorking ? 'warn' : fbNeverHeard ? 'warn' : anyConfigured ? 'err' : '';

            // [ข้อ 18] tooltip ใช้อีโมจิล้วนต้องจำเองว่าอันไหนคือช่องทางไหน — ใส่ชื่อช่องทางกำกับด้วย
            var parts = ['fb', 'lan', 'pb'].map(function(ch) { return CHANNEL_ICONS[ch] + ' ' + CHANNEL_NAMES[ch] + ': ' + s[ch].text; });
            if (appRelayState !== 'unconfigured') parts.push(CHANNEL_ICONS.app + ' ' + CHANNEL_NAMES.app + ': ' + s.app.text);
            var tip = parts.join(' · ');

            var led = document.getElementById('pbLed');
            if (led) { led.className = 'pb-led ' + cls; led.title = tip; }
            var miniLed = document.getElementById('miniPbLed');
            if (miniLed) { miniLed.className = 'mini-pb-led ' + cls; miniLed.title = tip; }

            ['fb', 'lan', 'pb', 'app'].forEach(function(ch) {
                var dot = document.getElementById('chLed_' + ch);
                if (dot) { dot.className = 'ch-led ' + s[ch].cls; dot.title = CHANNEL_NAMES[ch] + ': ' + s[ch].text; }
                var txt = document.getElementById('chLedText_' + ch);
                if (txt) txt.textContent = s[ch].text;
            });
            updateInboxBoxStatus(s);

            if (cls === 'err') { if (!combinedErrSince) combinedErrSince = Date.now(); }
            else combinedErrSince = 0;
            combinedLedState = cls;
            checkCombinedAlert();
        }

        // [ข้อ 11] กล่อง "📥 ช่องทางรับเงินเข้า" เดิมไม่มีสถานะของตัวเองเลย ต้องเดาจากไฟ titlebar หรือ
        // ไล่ดู log — เติมบรรทัดสถานะสั้นๆ ให้แต่ละช่องทางในกล่องนั้นโดยตรง
        function updateInboxBoxStatus(s) {
            var iconFor = function(cls) { return cls === 'ok' ? '🟢' : cls === 'warn' ? '🟡' : cls === 'err' ? '🔴' : '⚪'; };
            var setLine = function(id, ch) {
                var el = document.getElementById(id);
                if (!el || !s[ch]) return;
                el.textContent = iconFor(s[ch].cls) + ' ' + s[ch].text;
                el.className = 'inbox-status ' + (s[ch].cls || '');
            };
            setLine('inboxFbStatusLine', 'fb');
            setLine('inboxLanStatusLine', 'lan');
            setLine('inboxPbStatusLine', 'pb');
        }

        // เด้ง native notification เมื่อไฟรวมแดงเกิน 1 นาที (ซ้ำได้ทุก 5 นาทีถ้ายังแดงต่อเนื่อง) —
        // pbLog ไม่มีใครเห็นตอนหน้าต่างถูกย่อ/ซ่อนอยู่ใน tray
        function checkCombinedAlert() {
            if (!combinedErrSince || (Date.now() - combinedErrSince) < 60 * 1000) return;
            if ((Date.now() - combinedLastAlertAt) < 5 * 60 * 1000) return;
            combinedLastAlertAt = Date.now();
            if (window.heroWindow && window.heroWindow.notifyPbDisconnected) {
                window.heroWindow.notifyPbDisconnected(Math.max(1, Math.round((Date.now() - combinedErrSince) / 60000)));
            }
        }
        setInterval(updateCombinedLed, 10000);

        if (window.heroWindow && window.heroWindow.onNetworkChanged) {
            window.heroWindow.onNetworkChanged(function(info) {
                var ips = (info && info.ips && info.ips.length) ? info.ips.join(', ') : 'ไม่มี';
                pbLog('🌐 เครือข่ายเปลี่ยน (IP: ' + escapeHTML(ips) + ') → ต่อทุกช่องทางใหม่', 'w');
            });
        }

        // ==========================================
        // [ข้อ 7 + 17 feedback แอ๋ม] เผื่อพื้นที่ด้านล่างให้พ้นแผงปุ่มลอย (.floating-controls)
        // แผงปุ่มนี้ห่อบรรทัดเอง (flex-wrap) ตามความกว้างจอ (แคบสุด ~340px) ยิ่งปุ่มเยอะขึ้นเรื่อยๆ ตาม
        // เวอร์ชัน แผงก็ยิ่งสูงขึ้น — เดิม .paper ใช้ margin-bottom ตายตัว (96px) พอแผงสูงกว่านั้นก็ไป
        // บังบรรทัด "ค่าใช้จ่าย"/"สุทธิ" ท้ายตาราง (ตัวเลขสำคัญที่สุดของกะ) แม้เลื่อนจนสุดก็ไม่เห็น —
        // และป๊อปอัป "↩ กู้คืน" (bottom:25px ตายตัวเดิม) ก็ไปวางทับปุ่มแถวล่างพอดีด้วยเหตุผลเดียวกัน
        // แก้ด้วยตัวแปร CSS เดียว (--floatbar-h) วัดความสูงจริงของแผงแล้วให้ทั้งคู่ใช้ร่วมกัน
        // (ดู .paper และ .undo-toast ใน base.css/theme-hero.css)
        // ==========================================
        function adjustFloatingBarSpace() {
            var bar = document.querySelector('.floating-controls');
            if (!bar) return;
            var h = bar.offsetHeight;
            if (h > 0) document.documentElement.style.setProperty('--floatbar-h', (h + 20) + 'px');
        }
        window.addEventListener('resize', adjustFloatingBarSpace);
        if (window.ResizeObserver) {
            document.addEventListener('DOMContentLoaded', function() {
                var bar = document.querySelector('.floating-controls');
                if (bar) new ResizeObserver(adjustFloatingBarSpace).observe(bar);
            });
        }
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(adjustFloatingBarSpace);
        adjustFloatingBarSpace();

        // ==========================================
        // Initialize App
        // ==========================================
        initDrawerTable();
        initExchangeTable();
        handleTypeChange();
        renderTable();
        adjustFloatingBarSpace();

