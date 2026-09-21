import test from 'node:test';
import assert from 'node:assert/strict';
import * as Core from '../src/photo-rename-core.ts';

const encoder = new TextEncoder();
let nextRecordId = 1;

function mockFile(record, directory) {
    const bytes = encoder.encode(record.content);
    const recordId = record.id;
    const version = record.version;
    const ensureReadable = () => {
        if (!directory.invalidateSnapshots) return;
        const current = directory.entryById(recordId)?.record;
        if (!current || current.version !== version) {
            throw new DOMException('File snapshot invalidated', 'NotReadableError');
        }
    };
    return {
        size: bytes.length,
        lastModified: record.lastModified,
        get content() {
            ensureReadable();
            return record.content;
        },
        slice(start, end) {
            return {
                async arrayBuffer() {
                    ensureReadable();
                    return bytes.slice(start, end).buffer;
                }
            };
        }
    };
}

class MockFileHandle {
    constructor(directory, name, recordId) {
        this.kind = 'file';
        this.directory = directory;
        this.name = name;
        this.recordId = recordId;
    }

    currentEntry() {
        return this.directory.entryById(this.recordId);
    }

    async getFile() {
        const entry = this.currentEntry();
        if (!entry) throw new DOMException('File not found', 'NotFoundError');
        return mockFile(entry.record, this.directory);
    }

    async createWritable() {
        const handle = this;
        const directory = this.directory;
        let pendingContent = null;
        return {
            async write(sourceFile) {
                const entry = handle.currentEntry();
                if (!entry) throw new DOMException('File not found', 'NotFoundError');
                const sourceContent = sourceFile.content !== undefined
                    ? sourceFile.content
                    : new TextDecoder().decode(await sourceFile.arrayBuffer());
                if (directory.shouldFailWrite(entry.name, sourceContent)) throw new Error(`write failed: ${entry.name}`);
                pendingContent = directory.transformWrite(entry.name, sourceContent);
                if (directory.commitOnWrite) {
                    entry.record.content = pendingContent;
                    entry.record.lastModified += 1;
                    entry.record.version += 1;
                }
            },
            async close() {
                const entry = handle.currentEntry();
                if (!entry) throw new DOMException('File not found', 'NotFoundError');
                if (directory.shouldFailClose(entry.name, pendingContent)) throw new Error(`close failed: ${entry.name}`);
                if (pendingContent !== null) {
                    entry.record.content = pendingContent;
                    entry.record.lastModified += 1;
                    entry.record.version += 1;
                }
            },
            async abort() { pendingContent = null; }
        };
    }

    async isSameEntry(other) {
        return other instanceof MockFileHandle
            && other.directory === this.directory
            && other.recordId === this.recordId;
    }

    async remove() {
        await this.directory.removeHandle(this);
    }
}

class MockDirectoryHandle {
    constructor(entries = {}) {
        this.name = 'mock-photos';
        this.files = new Map(Object.entries(entries).map(([name, content], index) => [
            name,
            { id: nextRecordId++, content, lastModified: 1000 + index, version: 0 }
        ]));
        this.failWrite = () => false;
        this.failClose = () => false;
        this.writeTransform = (_name, content) => content;
        this.failRemoveNames = new Set();
        this.beforeCreate = () => {};
        this.beforeRemove = () => {};
        this.afterRemove = () => {};
        this.nameKey = name => name;
        this.invalidateSnapshots = false;
        this.commitOnWrite = false;
    }

    shouldFailWrite(name, content) {
        return this.failWrite(name, content);
    }

    shouldFailClose(name, content) {
        return this.failClose(name, content);
    }

    transformWrite(name, content) {
        return this.writeTransform(name, content);
    }

    resolvedName(name) {
        const key = this.nameKey(name);
        return [...this.files.keys()].find(existing => this.nameKey(existing) === key) || null;
    }

    entryById(recordId) {
        for (const [name, record] of this.files) {
            if (record.id === recordId) return { name, record };
        }
        return null;
    }

    put(name, content, lastModified = 9000) {
        this.files.set(name, { id: nextRecordId++, content, lastModified, version: 0 });
    }

    replace(name, content, lastModified = 9000) {
        const resolved = this.resolvedName(name);
        if (resolved) this.files.delete(resolved);
        this.put(name, content, lastModified);
    }

    async *values() {
        for (const [name, record] of [...this.files.entries()]) {
            yield new MockFileHandle(this, name, record.id);
        }
    }

    async getFileHandle(name, options = {}) {
        let resolved = this.resolvedName(name);
        if (!resolved) {
            if (!options.create) throw new DOMException('File not found', 'NotFoundError');
            this.beforeCreate(name, this);
            resolved = this.resolvedName(name);
            if (!resolved) {
                this.put(name, '', 1);
                resolved = name;
            }
        }
        const record = this.files.get(resolved);
        return new MockFileHandle(this, resolved, record.id);
    }

    async removeEntry(name) {
        const resolved = this.resolvedName(name);
        if (!resolved) throw new DOMException('File not found', 'NotFoundError');
        const record = this.files.get(resolved);
        await this.removeHandle(new MockFileHandle(this, resolved, record.id));
    }

    async removeHandle(handle) {
        const entry = this.entryById(handle.recordId);
        if (!entry) throw new DOMException('File not found', 'NotFoundError');
        this.beforeRemove(entry.name, handle, this);
        const current = this.entryById(handle.recordId);
        if (!current) throw new DOMException('File not found', 'NotFoundError');
        if (this.failRemoveNames.has(current.name)) throw new DOMException('Removal denied', 'NotAllowedError');
        this.files.delete(current.name);
        this.afterRemove(current.name, handle, this);
    }

    photo(name) {
        const resolved = this.resolvedName(name);
        const record = this.files.get(resolved);
        return {
            handle: new MockFileHandle(this, resolved, record.id),
            name: resolved,
            size: encoder.encode(record.content).length,
            lastModified: record.lastModified
        };
    }

    content(name) {
        const resolved = this.resolvedName(name);
        return resolved ? this.files.get(resolved)?.content : undefined;
    }

    names() {
        return [...this.files.keys()];
    }
}

function planFor(directory, options = {}) {
    const photoNames = options.photoNames || directory.names();
    return Core.buildRenamePlan({
        grade: options.grade || '1',
        classNum: options.classNum || '1',
        startNum: options.startNum || '1',
        names: options.names || ['Alice', 'Bob'],
        skippedIndices: options.skippedIndices || [],
        photos: photoNames.map(name => directory.photo(name)),
        existingNames: options.existingNames || directory.names()
    });
}

function assertNoTemporaryFiles(directory) {
    assert.equal(directory.names().some(name => name.startsWith(Core.TEMP_PREFIX)), false);
}

function createReservationFixture(overrides = {}) {
    const batchId = overrides.batchId || 'batch_123';
    const index = overrides.index ?? 0;
    const record = {
        batchId,
        index,
        originalName: 'IMG_1.jpg',
        newName: '1-1-01_Alice.jpg',
        tempName: `${Core.TEMP_PREFIX}${batchId}_${index}.tmp`,
        ...overrides
    };
    return {
        record,
        content: `${Core.RESERVATION_MAGIC}${JSON.stringify(record)}`
    };
}

function createJournalFixture(overrides = {}) {
    const batchId = overrides.batchId || 'journal_batch';
    const index = overrides.index ?? 0;
    return createReservationFixture({
        batchId,
        index,
        journalName: `${Core.JOURNAL_PREFIX}${batchId}_${index}.json`,
        ...overrides
    });
}

test('数字入りファイル名を自然順で並べる', () => {
    const names = ['photo10.jpg', 'photo2.jpg', 'photo1.jpg'];
    assert.deepEqual(names.sort(Core.naturalCompare), ['photo1.jpg', 'photo2.jpg', 'photo10.jpg']);
});

test('中断復旧用の予約記録は正しい形式だけを受理する', async () => {
    const valid = createReservationFixture({ originalName: '写真 あ.jpg', newName: '1-1-01_山田 花子.jpg' });
    assert.deepEqual(
        await Core.readReservationRecord(new Blob([valid.content])),
        valid.record
    );

    const forged = createReservationFixture({ tempName: `${Core.TEMP_PREFIX}別処理_0.tmp` });
    assert.equal(await Core.readReservationRecord(new Blob([forged.content])), null);
    assert.equal(await Core.readReservationRecord(new Blob(['ordinary image bytes'])), null);
});

test('公開後も残る独立した復旧台帳を受理する', async () => {
    const fixture = createJournalFixture();
    assert.deepEqual(await Core.readReservationRecord(new Blob([fixture.content])), fixture.record);

    const invalid = createJournalFixture({ journalName: `${Core.JOURNAL_PREFIX}other_0.json` });
    assert.equal(await Core.readReservationRecord(new Blob([invalid.content])), null);
});

test('一時コピー作成前の中断は原本に触れず復旧台帳だけを片付ける', async () => {
    const fixture = createJournalFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.journalName]: fixture.content
    });

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.journalName,
            handle: await directory.getFileHandle(fixture.record.journalName)
        }]
    });

    assert.equal(outcome.clean, true);
    assert.deepEqual(directory.names(), [fixture.record.originalName]);
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
});

test('空の一時コピーを作成した直後の中断は原本照合後に内部ファイルだけ片付ける', async () => {
    const fixture = createJournalFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: '',
        [fixture.record.journalName]: fixture.content
    });

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.journalName,
            handle: await directory.getFileHandle(fixture.record.journalName)
        }]
    });

    assert.equal(outcome.clean, true);
    assert.deepEqual(directory.names(), [fixture.record.originalName]);
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
});

test('公開後の中断は出力と一時コピーを照合して原名側へ安全に巻き戻す', async () => {
    const fixture = createJournalFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: 'SOURCE_A',
        [fixture.record.journalName]: fixture.content
    });

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.journalName,
            handle: await directory.getFileHandle(fixture.record.journalName)
        }]
    });

    assert.equal(outcome.clean, true);
    assert.deepEqual(directory.names(), [fixture.record.originalName]);
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
});

test('原本削除後の中断は出力を残して一時コピーと復旧台帳だけを片付ける', async () => {
    const fixture = createJournalFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: 'SOURCE_A',
        [fixture.record.journalName]: fixture.content
    });

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.journalName,
            handle: await directory.getFileHandle(fixture.record.journalName)
        }]
    });

    assert.equal(outcome.clean, true);
    assert.deepEqual(directory.names(), [fixture.record.newName]);
    assert.equal(directory.content(fixture.record.newName), 'SOURCE_A');
});

test('復旧中に出力マーカーを削除できなければ一時コピーと台帳を残す', async () => {
    const fixture = createJournalFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: fixture.content,
        [fixture.record.journalName]: fixture.content
    });
    directory.failRemoveNames.add(fixture.record.newName);

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.journalName,
            handle: await directory.getFileHandle(fixture.record.journalName)
        }]
    });

    assert.equal(outcome.clean, false);
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.tempName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.newName), fixture.content);
    assert.equal(directory.content(fixture.record.journalName), fixture.content);
});

test('復旧中に一時コピーを削除できなければ復旧台帳を残して再試行できる', async () => {
    const fixture = createJournalFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: 'SOURCE_A',
        [fixture.record.journalName]: fixture.content
    });
    const journalHandle = await directory.getFileHandle(fixture.record.journalName);
    directory.failRemoveNames.add(fixture.record.tempName);

    const first = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{ name: fixture.record.journalName, handle: journalHandle }]
    });
    assert.equal(first.clean, false);
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.tempName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.journalName), fixture.content);
    assert.equal(directory.content(fixture.record.newName), undefined);

    directory.failRemoveNames.delete(fixture.record.tempName);
    const second = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{ name: fixture.record.journalName, handle: journalHandle }]
    });
    assert.equal(second.clean, true);
    assert.deepEqual(directory.names(), [fixture.record.originalName]);
});

test('完了後に復旧台帳だけ残った場合は出力を変更せず台帳を片付ける', async () => {
    const fixture = createJournalFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.newName]: 'SOURCE_A',
        [fixture.record.journalName]: fixture.content
    });

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.journalName,
            handle: await directory.getFileHandle(fixture.record.journalName)
        }]
    });

    assert.equal(outcome.clean, true);
    assert.deepEqual(directory.names(), [fixture.record.newName]);
    assert.equal(directory.content(fixture.record.newName), 'SOURCE_A');
});

test('中断後の予約ファイルと一時ファイルを原本照合後に片付ける', async () => {
    const fixture = createReservationFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: fixture.content
    });
    const markerHandle = await directory.getFileHandle(fixture.record.newName);

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{ name: fixture.record.newName, handle: markerHandle }]
    });

    assert.equal(outcome.clean, true);
    assert.deepEqual(outcome.recovered, [{
        originalName: fixture.record.originalName,
        newName: fixture.record.newName
    }]);
    assert.deepEqual(directory.names(), [fixture.record.originalName]);
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
});

test('中断復旧時に原本と一時ファイルが不一致なら何も削除しない', async () => {
    const fixture = createReservationFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_B',
        [fixture.record.newName]: fixture.content
    });
    const before = directory.names();

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.newName,
            handle: await directory.getFileHandle(fixture.record.newName)
        }]
    });

    assert.equal(outcome.clean, false);
    assert.match(outcome.warnings.join('\n'), /内容が一致しません/);
    assert.deepEqual(directory.names(), before);
});

test('中断復旧時に原本と一時名が同じ実体を指すなら何も削除しない', async () => {
    const fixture = createReservationFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: fixture.content
    });
    directory.nameKey = name => [fixture.record.originalName, fixture.record.tempName].includes(name)
        ? 'source-alias'
        : name;

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.newName,
            handle: await directory.getFileHandle(fixture.record.newName)
        }]
    });

    assert.equal(outcome.clean, false);
    assert.match(outcome.warnings.join('\n'), /同じ保存先/);
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.newName), fixture.content);
});

test('中断復旧の確認後に予約ファイルが差し替わったら外部ファイルを残す', async () => {
    const fixture = createReservationFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: fixture.content
    });
    const markerHandle = await directory.getFileHandle(fixture.record.newName);
    directory.replace(fixture.record.newName, 'EXTERNAL');

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{ name: fixture.record.newName, handle: markerHandle }]
    });

    assert.equal(outcome.clean, false);
    assert.equal(directory.content(fixture.record.newName), 'EXTERNAL');
    assert.equal(directory.content(fixture.record.tempName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
});

test('中断復旧のマーカー削除中に原本が差し替わったら一時ファイルを残す', async () => {
    const fixture = createReservationFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: fixture.content
    });
    directory.beforeRemove = (name, _handle, target) => {
        if (name === fixture.record.newName) {
            target.replace(fixture.record.originalName, 'EXTERNAL');
        }
    };

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.newName,
            handle: await directory.getFileHandle(fixture.record.newName)
        }]
    });

    assert.equal(outcome.clean, false);
    assert.equal(directory.content(fixture.record.originalName), 'EXTERNAL');
    assert.equal(directory.content(fixture.record.tempName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.newName), undefined);
    assert.match(outcome.warnings.join('\n'), /原本.*別のファイルへ置き換え/);
});

test('中断復旧でマーカーを削除できなければ一時ファイルも削除しない', async () => {
    const fixture = createReservationFixture();
    const directory = new MockDirectoryHandle({
        [fixture.record.originalName]: 'SOURCE_A',
        [fixture.record.tempName]: 'SOURCE_A',
        [fixture.record.newName]: fixture.content
    });
    directory.failRemoveNames.add(fixture.record.newName);

    const outcome = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{
            name: fixture.record.newName,
            handle: await directory.getFileHandle(fixture.record.newName)
        }]
    });

    assert.equal(outcome.clean, false);
    assert.equal(directory.content(fixture.record.originalName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.tempName), 'SOURCE_A');
    assert.equal(directory.content(fixture.record.newName), fixture.content);
});

test('空行を黙って詰めずエラーにする', () => {
    const parsed = Core.parseNameList('Alice\n\nBob\n');
    assert.deepEqual(parsed.names, ['Alice', '', 'Bob']);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0], /2 行目が空欄/);
    assert.match(parsed.errors[0], /空欄行を削除/);
    assert.doesNotMatch(parsed.errors[0], /欠席/);
});

test('開始番号は1〜99の整数だけ許可する', () => {
    assert.equal(Core.validateStartNumber('1').ok, true);
    assert.equal(Core.validateStartNumber('99').ok, true);
    for (const invalid of ['', '0', '-5', '1.5', '100', '1e2']) {
        assert.equal(Core.validateStartNumber(invalid).ok, false, invalid);
    }
});

test('危険なファイル名文字を事前に拒否する', () => {
    for (const value of ['A/B', 'A\\B', 'A:B', 'A\tB']) {
        assert.equal(Core.validateComponent(value, '名前').ok, false, value);
    }
    assert.equal(Core.validateComponent('山田 太郎', '名前').ok, true);
});

test('ブラウザで安定して確認できない画像形式を対象外にする', () => {
    assert.equal(Core.isImageFile('photo.jpg'), true);
    assert.equal(Core.isImageFile('photo.webp'), true);
    assert.equal(Core.isImageFile('photo.heic'), false);
    assert.equal(Core.isImageFile('photo.tiff'), false);
});

test('写真数と名前数が一致しない計画を拒否する', () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'A', 'IMG_2.jpg': 'B' });
    const plan = planFor(directory, { names: ['Alice'] });
    assert.equal(plan.ok, false);
    assert.match(plan.errors.join('\n'), /件数を一致/);
});

test('欠席者を飛ばしても出席番号は維持する', () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'A', 'IMG_2.jpg': 'B' });
    const plan = planFor(directory, {
        names: ['Alice', 'Absent', 'Bob'],
        skippedIndices: [1]
    });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.items.map(item => item.newName), [
        '1-1-01_Alice.jpg',
        '1-1-03_Bob.jpg'
    ]);
});

test('既存の出力先との衝突を計画段階で拒否する', () => {
    const directory = new MockDirectoryHandle({
        '0.jpg': 'SOURCE_A',
        'Z-1-01_Alice.jpg': 'SOURCE_B'
    });
    const plan = planFor(directory, { grade: 'Z' });
    assert.equal(plan.ok, false);
    assert.match(plan.errors.join('\n'), /すでに存在/);
    assert.equal(directory.content('0.jpg'), 'SOURCE_A');
    assert.equal(directory.content('Z-1-01_Alice.jpg'), 'SOURCE_B');
});

test('大文字小文字・Unicode正規化だけが異なる変更を拒否する', () => {
    const directory = new MockDirectoryHandle({ '1-1-01_alice.jpg': 'A' });
    const plan = planFor(directory, {
        names: ['Alice'],
        photoNames: ['1-1-01_alice.jpg']
    });
    assert.equal(plan.ok, false);
    assert.match(plan.errors.join('\n'), /安全でない変更/);
});

test('通常系は2枚の内容を保持して安全に置換する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    assert.equal(plan.ok, true);

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });

    assert.deepEqual(directory.names().sort(), ['1-1-01_Alice.jpg', '1-1-02_Bob.jpg']);
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'SOURCE_A');
    assert.equal(directory.content('1-1-02_Bob.jpg'), 'SOURCE_B');
    assert.equal(outcome.warnings.length, 0);
    assert.equal(outcome.clean, true);
    assert.deepEqual(outcome.results.map(result => result.status), ['success', 'success']);
    assertNoTemporaryFiles(directory);
});

test('通常処理で一時コピー削除に失敗したら復旧台帳も残して再試行できる', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.afterRemove = (name, _handle, target) => {
        if (name !== 'IMG_1.jpg') return;
        const tempName = target.names().find(entry => entry.startsWith(Core.TEMP_PREFIX));
        target.failRemoveNames.add(tempName);
    };

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    const tempName = directory.names().find(name => name.startsWith(Core.TEMP_PREFIX));
    const journalName = directory.names().find(name => name.startsWith(Core.JOURNAL_PREFIX));

    assert.equal(outcome.clean, false);
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'SOURCE_A');
    assert.equal(directory.content(tempName), 'SOURCE_A');
    assert.ok(journalName);

    directory.failRemoveNames.delete(tempName);
    const recovered = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{ name: journalName, handle: await directory.getFileHandle(journalName) }]
    });
    assert.equal(recovered.clean, true);
    assert.deepEqual(directory.names(), ['1-1-01_Alice.jpg']);
});

test('通常処理で復旧台帳削除だけ失敗しても再試行時に出力を変更しない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.beforeRemove = (name, _handle, target) => {
        if (!name.startsWith(Core.TEMP_PREFIX)) return;
        const journalName = target.names().find(entry => entry.startsWith(Core.JOURNAL_PREFIX));
        target.failRemoveNames.add(journalName);
    };

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    const journalName = directory.names().find(name => name.startsWith(Core.JOURNAL_PREFIX));

    assert.equal(outcome.clean, false);
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'SOURCE_A');
    assert.ok(journalName);
    assert.equal(directory.names().some(name => name.startsWith(Core.TEMP_PREFIX)), false);

    directory.failRemoveNames.delete(journalName);
    const recovered = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{ name: journalName, handle: await directory.getFileHandle(journalName) }]
    });
    assert.equal(recovered.clean, true);
    assert.deepEqual(directory.names(), ['1-1-01_Alice.jpg']);
});

test('実行直前に出力先が作られたら原本無変更で中止する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    directory.put('1-1-01_Alice.jpg', 'EXTERNAL', 9999);

    await assert.rejects(
        Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items }),
        /すでに存在/
    );
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assert.equal(directory.content('IMG_2.jpg'), 'SOURCE_B');
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'EXTERNAL');
    assertNoTemporaryFiles(directory);
});

test('出力中の書き込み失敗は作成物を巻き戻し原本を保持する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    directory.failWrite = (name, content) => name === '1-1-02_Bob.jpg' && content === 'SOURCE_B';

    await assert.rejects(
        Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items }),
        /write failed/
    );
    assert.deepEqual(directory.names().sort(), ['IMG_1.jpg', 'IMG_2.jpg']);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assert.equal(directory.content('IMG_2.jpg'), 'SOURCE_B');
    assertNoTemporaryFiles(directory);
});

test('一時コピー失敗後に原本が消えていたら正常な一時コピーを削除しない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    directory.failWrite = (name, content) => {
        if (name.startsWith(Core.TEMP_PREFIX) && content === 'SOURCE_B') {
            directory.files.delete('IMG_1.jpg');
            return true;
        }
        return false;
    };

    let caught;
    try {
        await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    } catch (error) {
        caught = error;
    }

    const tempNames = directory.names().filter(name => name.startsWith(Core.TEMP_PREFIX));
    assert.ok(caught);
    assert.equal(directory.content('IMG_1.jpg'), undefined);
    assert.equal(tempNames.length, 1);
    assert.equal(directory.content(tempNames[0]), 'SOURCE_A');
    assert.match((caught.cleanupWarnings || []).join('\n'), /元ファイルを再確認できない/);
});

test('出力失敗後に原本が消えていたら正常な出力と一時コピーを残す', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    directory.failWrite = (name, content) => {
        if (name === '1-1-02_Bob.jpg' && content === 'SOURCE_B') {
            directory.files.delete('IMG_1.jpg');
            return true;
        }
        return false;
    };

    let caught;
    try {
        await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    } catch (error) {
        caught = error;
    }

    const tempNames = directory.names().filter(name => name.startsWith(Core.TEMP_PREFIX));
    assert.ok(caught);
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'SOURCE_A');
    assert.equal(tempNames.length, 1);
    assert.equal(directory.content(tempNames[0]), 'SOURCE_A');
    assert.match((caught.cleanupWarnings || []).join('\n'), /元ファイルを再確認できない/);
});

test('元ファイル削除失敗時は新旧両方を残して警告する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    directory.failRemoveNames.add('IMG_2.jpg');

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });

    assert.equal(directory.content('1-1-01_Alice.jpg'), 'SOURCE_A');
    assert.equal(directory.content('1-1-02_Bob.jpg'), 'SOURCE_B');
    assert.equal(directory.content('IMG_2.jpg'), 'SOURCE_B');
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], /新旧両方/);
    assert.equal(outcome.clean, false);
    assert.equal(outcome.results[1].status, 'partial');
    assert.equal(outcome.results[1].success, false);
    assertNoTemporaryFiles(directory);
});

test('選択後に写真が変わったら書き込み前に中止する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    directory.replace('IMG_2.jpg', 'CHANGED-LONGER', 5000);

    await assert.rejects(
        Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items }),
        /選択時から変更/
    );
    assert.deepEqual(directory.names().sort(), ['IMG_1.jpg', 'IMG_2.jpg']);
    assertNoTemporaryFiles(directory);
});

test('すでに目的名なら再書き込みも削除もしない', async () => {
    const directory = new MockDirectoryHandle({ '1-1-01_Alice.jpg': 'SOURCE_A' });
    const originalTimestamp = directory.files.get('1-1-01_Alice.jpg').lastModified;
    const plan = planFor(directory, {
        names: ['Alice'],
        photoNames: ['1-1-01_Alice.jpg']
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.items[0].noOp, true);

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });

    assert.equal(outcome.results[0].unchanged, true);
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'SOURCE_A');
    assert.equal(directory.files.get('1-1-01_Alice.jpg').lastModified, originalTimestamp);
});

test('OS上で同じ実体へ解決される別名は実行時に拒否する', async () => {
    const directory = new MockDirectoryHandle({ '1-1-01_Straße.jpg': 'SOURCE_A' });
    directory.nameKey = name => name
        .normalize('NFKC')
        .toLocaleLowerCase('de-DE')
        .replaceAll('ß', 'ss')
        .replaceAll('ς', 'σ');
    const plan = planFor(directory, {
        names: ['STRASSE'],
        photoNames: ['1-1-01_Straße.jpg']
    });
    assert.equal(plan.ok, true, '文字列正規化だけでは衝突を検出できない前提');

    await assert.rejects(
        Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items }),
        /すでに存在/
    );
    assert.deepEqual(directory.names(), ['1-1-01_Straße.jpg']);
    assert.equal(directory.content('1-1-01_Straße.jpg'), 'SOURCE_A');
});

test('存在確認と作成の間に外部ファイルが現れても上書きも削除もしない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.beforeCreate = (name, target) => {
        if (name === '1-1-01_Alice.jpg') target.put(name, 'EXTERNAL', 7777);
    };

    let caught;
    try {
        await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    } catch (error) {
        caught = error;
    }
    assert.ok(caught);
    assert.match(caught.message, /上書きせず中止/);
    assert.match((caught.cleanupWarnings || []).join('\n'), /所有確認に失敗/);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'EXTERNAL');
    assertNoTemporaryFiles(directory);
});

test('同じサイズの書き込み破損も全バイト照合で検出する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.writeTransform = (name, content) => name === '1-1-01_Alice.jpg' && content === 'SOURCE_A'
        ? 'BROKEN!!'
        : content;

    let caught;
    try {
        await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    } catch (error) {
        caught = error;
    }
    assert.ok(caught);
    assert.match(caught.message, /ファイル内容が元ファイルと一致しません/);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'BROKEN!!');
    assert.match((caught.cleanupWarnings || []).join('\n'), /内容が処理中に変わったため削除しません/);
    assertNoTemporaryFiles(directory);
});

test('削除直前に元ファイルが同名別実体へ差し替わっても差し替え後を消さない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    let replaced = false;
    directory.beforeRemove = (name, _handle, target) => {
        if (name === 'IMG_1.jpg' && !replaced) {
            replaced = true;
            target.replace(name, 'EXTERNAL', 8888);
        }
    };

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });

    assert.equal(directory.content('IMG_1.jpg'), 'EXTERNAL');
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'SOURCE_A');
    assert.match(outcome.warnings.join('\n'), /削除しませんでした/);
    assertNoTemporaryFiles(directory);
});

test('同じサイズ・同じ更新日時でも処理中に原本内容が変われば削除しない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    let changed = false;

    const outcome = await Core.executeSafeRenameBatch({
        dirHandle: directory,
        items: plan.items,
        onProgress(detail) {
            if (detail.phase === 'cleanup' && !changed) {
                changed = true;
                directory.files.get('IMG_1.jpg').content = 'SOURCE_X';
            }
        }
    });

    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_X');
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'SOURCE_A');
    assert.match(outcome.warnings.join('\n'), /複製内容が一致しない/);
    assertNoTemporaryFiles(directory);
});

test('原本削除後に出力内容が壊れたら原名を一時ファイルから復元する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.afterRemove = (name, _handle, target) => {
        if (name === 'IMG_1.jpg') {
            const finalRecord = target.files.get('1-1-01_Alice.jpg');
            finalRecord.content = 'BROKEN!!';
        }
    };

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });

    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'BROKEN!!');
    assert.match(outcome.warnings.join('\n'), /一時ファイルから復元/);
    assert.equal(outcome.clean, false);
    assert.equal(outcome.results[0].status, 'restored');
    assert.equal(outcome.results[0].success, false);
    assertNoTemporaryFiles(directory);
});

test('原名への復元書き込みに失敗したら空の原名を除去して一時ファイルを残す', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.afterRemove = (name, _handle, target) => {
        if (name === 'IMG_1.jpg') {
            target.files.get('1-1-01_Alice.jpg').content = 'BROKEN!!';
        }
    };
    directory.failClose = (name, content) => name === 'IMG_1.jpg' && content === 'SOURCE_A';

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    const tempNames = directory.names().filter(name => name.startsWith(Core.TEMP_PREFIX));

    assert.equal(outcome.clean, false);
    assert.equal(outcome.results[0].status, 'failed');
    assert.equal(directory.content('IMG_1.jpg'), undefined);
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'BROKEN!!');
    assert.equal(tempNames.length, 1);
    assert.equal(directory.content(tempNames[0]), 'SOURCE_A');
    assert.match(outcome.warnings.join('\n'), /自動復元に失敗/);
});

test('原名への復元が部分書き込みで失敗したら不確かな内容と一時ファイルを両方残す', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.afterRemove = (name, _handle, target) => {
        if (name === 'IMG_1.jpg') {
            target.files.get('1-1-01_Alice.jpg').content = 'BROKEN!!';
            target.commitOnWrite = true;
        }
    };
    directory.writeTransform = (name, content) => name === 'IMG_1.jpg' && content === 'SOURCE_A'
        ? 'PART'
        : content;
    directory.failClose = name => name === 'IMG_1.jpg';

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    const tempNames = directory.names().filter(name => name.startsWith(Core.TEMP_PREFIX));

    assert.equal(outcome.clean, false);
    assert.equal(outcome.results[0].status, 'failed');
    assert.equal(directory.content('IMG_1.jpg'), 'PART');
    assert.equal(tempNames.length, 1);
    assert.equal(directory.content(tempNames[0]), 'SOURCE_A');
    assert.match(outcome.warnings.join('\n'), /復元途中のファイルも削除できませんでした/);
});

test('復元先が一時ファイルと同じ実体へ解決されたら復元成功と誤認しない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.afterRemove = (name, _handle, target) => {
        if (name === 'IMG_1.jpg') target.files.get('1-1-01_Alice.jpg').content = 'BROKEN!!';
    };
    directory.beforeCreate = (name, target) => {
        if (name !== 'IMG_1.jpg') return;
        const tempName = target.names().find(entry => entry.startsWith(Core.TEMP_PREFIX));
        target.nameKey = candidate => [name, tempName].includes(candidate) ? 'restore-alias' : candidate;
    };

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    const tempNames = directory.names().filter(name => name.startsWith(Core.TEMP_PREFIX));

    assert.equal(outcome.clean, false);
    assert.equal(outcome.results[0].status, 'failed');
    assert.equal(directory.files.has('IMG_1.jpg'), false);
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'BROKEN!!');
    assert.equal(tempNames.length, 1);
    assert.equal(directory.files.get(tempNames[0]).content, 'SOURCE_A');
    assert.match(outcome.warnings.join('\n'), /復元先を安全に所有できませんでした/);
});

test('後続写真の処理中に先行出力が消えたら先行一時コピーを削除しない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    directory.beforeRemove = (name, _handle, target) => {
        if (name === 'IMG_2.jpg') target.files.delete('1-1-01_Alice.jpg');
    };

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    const tempNames = directory.names().filter(name => name.startsWith(Core.TEMP_PREFIX));

    assert.equal(outcome.clean, false);
    assert.equal(directory.content('1-1-01_Alice.jpg'), undefined);
    assert.equal(tempNames.length, 1);
    assert.equal(directory.content(tempNames[0]), 'SOURCE_A');
    assert.match(outcome.warnings.join('\n'), /正常な保存先を再確認できない/);
});

test('失敗時の後片付け直前に出力先が差し替わっても外部ファイルを消さない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A', 'IMG_2.jpg': 'SOURCE_B' });
    const plan = planFor(directory);
    let replaced = false;
    directory.failWrite = (name, content) => {
        if (name !== '1-1-02_Bob.jpg' || content !== 'SOURCE_B') return false;
        if (!replaced) {
            replaced = true;
            directory.replace('1-1-01_Alice.jpg', 'EXTERNAL', 9999);
        }
        return true;
    };

    let caught;
    try {
        await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    } catch (error) {
        caught = error;
    }
    assert.ok(caught);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assert.equal(directory.content('IMG_2.jpg'), 'SOURCE_B');
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'EXTERNAL');
    assert.match((caught.cleanupWarnings || []).join('\n'), /別のファイルへ置き換えられたため削除しません/);
    assertNoTemporaryFiles(directory);
});

test('空の外部出力先へ予約後に外部書き込みがあれば原本を残して中止する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.beforeCreate = (name, target) => {
        if (name === '1-1-01_Alice.jpg') target.put(name, '', 7777);
    };
    let interfered = false;

    let caught;
    try {
        await Core.executeSafeRenameBatch({
            dirHandle: directory,
            items: plan.items,
            onProgress(detail) {
                if (detail.phase === 'publish' && !interfered) {
                    interfered = true;
                    const target = directory.files.get('1-1-01_Alice.jpg');
                    target.content = 'EXTERNAL';
                    target.lastModified = 8888;
                }
            }
        });
    } catch (error) {
        caught = error;
    }

    assert.ok(caught);
    assert.match(caught.message, /内容が処理中に変わりました/);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assert.equal(directory.content('1-1-01_Alice.jpg'), 'EXTERNAL');
    assert.match((caught.cleanupWarnings || []).join('\n'), /内容が処理中に変わったため削除しません/);
    assertNoTemporaryFiles(directory);
});

test('安全なハンドル削除に非対応なら書き込み前に中止する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    plan.items[0].handle.remove = undefined;

    await assert.rejects(
        Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items }),
        /原本を安全に削除できません/
    );
    assert.deepEqual(directory.names(), ['IMG_1.jpg']);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
});

test('出力先のclose失敗は予約状態へ戻して作成物を片付ける', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.failClose = (name, content) => name === '1-1-01_Alice.jpg' && content === 'SOURCE_A';

    await assert.rejects(
        Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items }),
        /close failed/
    );
    assert.deepEqual(directory.names(), ['IMG_1.jpg']);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assertNoTemporaryFiles(directory);
});

test('予約マーカーのclose失敗で内容が残ったら独立台帳を保持して再試行できる', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.commitOnWrite = true;
    directory.failClose = (name, content) => name === '1-1-01_Alice.jpg'
        && String(content).startsWith(Core.RESERVATION_MAGIC);

    let caught;
    try {
        await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });
    } catch (error) {
        caught = error;
    }

    const journalName = directory.names().find(name => name.startsWith(Core.JOURNAL_PREFIX));
    assert.ok(caught);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assert.ok(directory.content('1-1-01_Alice.jpg').startsWith(Core.RESERVATION_MAGIC));
    assert.ok(journalName);
    assert.equal(directory.names().some(name => name.startsWith(Core.TEMP_PREFIX)), false);

    directory.failClose = () => false;
    const recovered = await Core.recoverInterruptedReservations({
        dirHandle: directory,
        reservations: [{ name: journalName, handle: await directory.getFileHandle(journalName) }]
    });
    assert.equal(recovered.clean, true);
    assert.deepEqual(directory.names(), ['IMG_1.jpg']);
});

test('一時ファイルのclose失敗でも原本だけを保持する', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.failClose = name => name.startsWith(Core.TEMP_PREFIX);

    await assert.rejects(
        Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items }),
        /close failed/
    );
    assert.deepEqual(directory.names(), ['IMG_1.jpg']);
    assert.equal(directory.content('IMG_1.jpg'), 'SOURCE_A');
    assertNoTemporaryFiles(directory);
});

test('1MiB境界より後ろの1バイト破損も検出する', async () => {
    const original = `${'A'.repeat(1024 * 1024)}B`;
    const corrupted = `${'A'.repeat(1024 * 1024)}C`;
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': original });
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    directory.writeTransform = (name, content) => name === '1-1-01_Alice.jpg' && content === original
        ? corrupted
        : content;

    await assert.rejects(
        Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items }),
        /ファイル内容が元ファイルと一致しません/
    );
    assert.equal(directory.content('IMG_1.jpg'), original);
    assert.equal(directory.content('1-1-01_Alice.jpg'), corrupted);
    assertNoTemporaryFiles(directory);
});

test('100枚の一括処理でも順序・内容・後片付けを保つ', async () => {
    const count = 100;
    const entries = Object.fromEntries(Array.from({ length: count }, (_, index) => [
        `IMG_${index + 1}.jpg`,
        `PHOTO_${index + 1}`
    ]));
    const names = Array.from({ length: count }, (_, index) => `Student${index + 1}`);
    const directory = new MockDirectoryHandle(entries);
    const photoNames = directory.names().sort(Core.naturalCompare);
    const plan = planFor(directory, { names, photoNames });

    const outcome = await Core.executeSafeRenameBatch({ dirHandle: directory, items: plan.items });

    assert.equal(outcome.clean, true);
    assert.equal(outcome.results.length, count);
    assert.equal(directory.names().length, count);
    assert.equal(directory.content('1-1-01_Student1.jpg'), 'PHOTO_1');
    assert.equal(directory.content('1-1-100_Student100.jpg'), 'PHOTO_100');
    assertNoTemporaryFiles(directory);
});

test('実API同様に元Fileスナップショットが無効化されても原本を削除しない', async () => {
    const directory = new MockDirectoryHandle({ 'IMG_1.jpg': 'SOURCE_A' });
    directory.invalidateSnapshots = true;
    const plan = planFor(directory, { names: ['Alice'], photoNames: ['IMG_1.jpg'] });
    let changed = false;

    await assert.rejects(
        Core.executeSafeRenameBatch({
            dirHandle: directory,
            items: plan.items,
            onProgress(detail) {
                if (detail.phase === 'stage' && !changed) {
                    changed = true;
                    const source = directory.files.get('IMG_1.jpg');
                    source.content = 'CHANGED!';
                    source.lastModified = 7000;
                    source.version += 1;
                }
            }
        }),
        /snapshot invalidated/
    );

    assert.deepEqual(directory.names(), ['IMG_1.jpg']);
    assert.equal(directory.content('IMG_1.jpg'), 'CHANGED!');
    assertNoTemporaryFiles(directory);
});
