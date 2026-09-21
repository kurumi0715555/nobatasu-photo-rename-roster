
type FileEntry = { name: string; handle: FileSystemFileHandle };
type OwnedEntry = FileEntry & {
    referenceFile?: Blob;
    referenceFiles?: Blob[];
    allowEmpty?: boolean;
};
type ReservationRecord = {
    batchId: string;
    index: number;
    originalName: string;
    newName: string;
    tempName: string;
    journalName?: string;
};
type RenameItem = {
    handle: FileSystemFileHandle;
    originalName: string;
    newName: string;
    rosterIndex: number;
    photoIndex: number;
    size: number;
    lastModified: number;
    noOp: boolean;
};
type PreparedItem = RenameItem & { sourceFile: File };
type StagedItem = PreparedItem & {
    tempName: string;
    journalName: string;
    tempHandle: FileSystemFileHandle;
    journalHandle: FileSystemFileHandle;
    reservationFile: Blob;
    ownershipConfirmed: boolean;
};
type PublishedItem = StagedItem & {
    finalHandle: FileSystemFileHandle;
    finalWritten: boolean;
    resultStatus: 'pending' | 'success' | 'partial' | 'restored' | 'failed';
    resultMessage?: string;
};
type ProgressDetail = { phase: 'validate' | 'stage' | 'publish' | 'cleanup'; current: number; total: number };
type RenameFailure = Error & { cleanupWarnings?: string[] };
type StringResult = { ok: true; value: string } | { ok: false; error: string };
type NumberResult = { ok: true; value: number } | { ok: false; error: string };
type PhotoInput = FileEntry & { size: number; lastModified: number };
type RenamePlan = { ok: boolean; errors: string[]; items: RenameItem[]; activeCount: number; photoCount: number };
type BuildRenamePlanOptions = {
    grade?: unknown;
    classNum?: unknown;
    startNum?: unknown;
    names?: string[];
    skippedIndices?: number[];
    photos?: PhotoInput[];
    existingNames?: string[];
};
type ReservationEntry = FileEntry & { record: ReservationRecord; kind: 'journal' | 'marker' };
type DurableEntry = Pick<OwnedEntry, 'name' | 'handle'>;
type NamedHandle = { name: string; handle: FileSystemFileHandle };
type LabeledHandle = { label: string; handle: FileSystemFileHandle | null };
type ProgressCallback = (detail: ProgressDetail) => void;
type ExecutionResult = {
    success: boolean;
    status: 'unchanged' | 'pending' | 'success' | 'partial' | 'restored' | 'failed';
    unchanged: boolean;
    original: string;
    newName: string;
    message?: string;
};
type RenameOutcome = { results: ExecutionResult[]; warnings: string[]; clean: boolean };
type RecoverOutcome = { recovered: Array<Pick<ReservationRecord, 'originalName' | 'newName'>>; warnings: string[]; clean: boolean };
type RestoreOutcome = { restored: boolean; warning: string; handle?: FileSystemFileHandle };
type SafeRenameOptions = { dirHandle?: FileSystemDirectoryHandle; items?: RenameItem[]; onProgress?: ProgressCallback };
type RecoverOptions = { dirHandle?: FileSystemDirectoryHandle; reservations?: Array<Pick<ReservationEntry, 'name' | 'handle'>> };
type JournalEntry = { item: StagedItem; name: string; handle: FileSystemFileHandle; ownershipConfirmed: boolean };
type RemovableTemp = { item: PublishedItem; durableEntries: DurableEntry[] };

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string | undefined {
    return error instanceof DOMException || error instanceof Error ? error.name : undefined;
}

function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
    return handle.kind === 'file';
}

function toRenameFailure(error: unknown): RenameFailure {
    return error instanceof Error ? error as RenameFailure : new Error(errorMessage(error));
}

    // Chromiumでサムネイル確認できる形式だけを対象にする。
    // HEIC/HEIF/TIFFは環境差が大きく、確認不能なまま氏名を付ける事故を避けるため除外する。
    const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']);
    const MAX_FILE_NAME_BYTES = 240;
    const MAX_COMPONENT_BYTES = 100;
    const TEMP_PREFIX = '__nobatasu_photo_rename_tmp_';
    const JOURNAL_PREFIX = '__nobatasu_photo_rename_journal_';
    const RESERVATION_MAGIC = 'NOBATASU_PHOTO_RENAME_RESERVATION_V1\n';
    const MAX_RESERVATION_BYTES = 16 * 1024;
    const BYTE_COMPARE_CHUNK_SIZE = 1024 * 1024;
    const naturalCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

    function isImageFile(name: unknown): boolean {
        const text = String(name || '');
        const dotIndex = text.lastIndexOf('.');
        if (dotIndex <= 0 || dotIndex === text.length - 1) return false;
        return IMAGE_EXTS.has(text.slice(dotIndex + 1).toLowerCase());
    }

    function getExtension(name: unknown): string {
        const text = String(name || '');
        const dotIndex = text.lastIndexOf('.');
        return dotIndex > 0 && dotIndex < text.length - 1 ? text.slice(dotIndex + 1) : '';
    }

    function naturalCompare(a: unknown, b: unknown): number {
        const left = String(a);
        const right = String(b);
        return naturalCollator.compare(left, right) || left.localeCompare(right, 'ja');
    }

    function canonicalName(name: unknown): string {
        return String(name || '').normalize('NFC').toLocaleLowerCase('ja-JP');
    }

    function utf8ByteLength(value: unknown): number {
        const text = String(value || '');
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
        return unescape(encodeURIComponent(text)).length;
    }

    function parseNameList(raw: unknown): { names: string[]; errors: string[] } {
        const normalized = String(raw || '').replace(/\r\n?/g, '\n');
        const lines = normalized.split('\n');

        while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
            lines.pop();
        }

        if (lines.length === 0) return { names: [], errors: [] };

        const names = lines.map(line => line.trim());
        const blankLines: number[] = [];
        names.forEach((name, index) => {
            if (!name) blankLines.push(index + 1);
        });

        return {
            names,
            errors: blankLines.length > 0
                ? [`名前リストの ${blankLines.join('、')} 行目が空欄です。空欄行を削除してください。`]
                : []
        };
    }

    function validateStartNumber(value: unknown): NumberResult {
        const text = String(value ?? '').trim();
        const number = text === '' ? NaN : Number(text);
        if (!Number.isInteger(number) || number < 1 || number > 99) {
            return { ok: false, error: '開始番号は1〜99の整数で入力してください。' };
        }
        return { ok: true, value: number };
    }

    function validateComponent(value: unknown, label: string, maxBytes = MAX_COMPONENT_BYTES): StringResult {
        const text = String(value ?? '').trim();
        if (!text) return { ok: false, error: `${label}を入力してください。` };
        if (/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(text)) {
            return { ok: false, error: `${label}にファイル名として使用できない文字が含まれています。` };
        }
        if (text === '.' || text === '..' || /[. ]$/u.test(text)) {
            return { ok: false, error: `${label}の末尾にピリオドや空白は使用できません。` };
        }
        if (utf8ByteLength(text) > maxBytes) {
            return { ok: false, error: `${label}が長すぎます。${maxBytes}バイト以内にしてください。` };
        }
        return { ok: true, value: text };
    }

    function validateFileName(fileName: unknown): string {
        const text = String(fileName || '');
        if (!text || text === '.' || text === '..') return '出力ファイル名が空です。';
        if (/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(text)) {
            return `「${text}」にファイル名として使用できない文字が含まれています。`;
        }
        if (/[. ]$/u.test(text)) return `「${text}」の末尾にピリオドや空白は使用できません。`;
        if (utf8ByteLength(text) > MAX_FILE_NAME_BYTES) {
            return `「${text}」が長すぎます。ファイル名全体を${MAX_FILE_NAME_BYTES}バイト以内にしてください。`;
        }
        return '';
    }

    function uniqueMessages(messages: readonly unknown[]): string[] {
        return [...new Set(messages.filter((message): message is string => typeof message === 'string' && message.length > 0))];
    }

    function buildRenamePlan(options: BuildRenamePlanOptions = {}): RenamePlan {
        const {
            grade,
            classNum,
            startNum,
            names = [],
            skippedIndices = [],
            photos = [],
            existingNames = photos.map(photo => photo.name)
        } = options;

        const errors: string[] = [];
        const gradeResult = validateComponent(grade, '学年', 30);
        const classResult = validateComponent(classNum, '学級', 30);
        const startResult = validateStartNumber(startNum);
        if (!gradeResult.ok) errors.push(gradeResult.error);
        if (!classResult.ok) errors.push(classResult.error);
        if (!startResult.ok) errors.push(startResult.error);

        const sanitizedNames = names.map((name, index) => {
            if (!String(name || '').trim()) {
                errors.push(`名前リストの ${index + 1} 行目が空欄です。空欄行を削除してください。`);
                return '';
            }
            const result = validateComponent(name, `名前リストの${index + 1}行目`);
            if (!result.ok) errors.push(result.error);
            return result.ok ? result.value : String(name || '').trim();
        });

        const skipSet = new Set([...skippedIndices].filter((index): index is number => typeof index === 'number' && Number.isInteger(index)));
        const activeRoster = sanitizedNames
            .map((name, rosterIndex) => ({ name, rosterIndex }))
            .filter(item => !skipSet.has(item.rosterIndex));

        if (activeRoster.length === 0 || photos.length === 0) {
            errors.push('リネーム対象となる写真と名前を1件以上用意してください。');
        }
        if (activeRoster.length !== photos.length) {
            errors.push(`写真${photos.length}枚と有効な名前${activeRoster.length}名の件数を一致させてください。`);
        }

        const safeGrade = gradeResult.ok ? gradeResult.value : String(grade || '').trim();
        const safeClass = classResult.ok ? classResult.value : String(classNum || '').trim();
        const safeStart = startResult.ok ? startResult.value : 1;
        const pairCount = Math.min(activeRoster.length, photos.length);
        const items: RenameItem[] = [];

        for (let photoIndex = 0; photoIndex < pairCount; photoIndex++) {
            const photo = photos[photoIndex];
            const roster = activeRoster[photoIndex];
            if (!photo || !roster) continue;
            const extension = getExtension(photo.name);
            if (!extension) {
                errors.push(`「${photo.name}」の拡張子を判定できません。`);
                continue;
            }

            const number = String(safeStart + roster.rosterIndex).padStart(2, '0');
            const newName = `${safeGrade}-${safeClass}-${number}_${roster.name}.${extension}`;
            const fileNameError = validateFileName(newName);
            if (fileNameError) errors.push(fileNameError);

            items.push({
                handle: photo.handle,
                originalName: photo.name,
                newName,
                rosterIndex: roster.rosterIndex,
                photoIndex,
                size: photo.size,
                lastModified: photo.lastModified,
                noOp: photo.name === newName
            });
        }

        const existingByCanonical = new Map<string, string[]>();
        existingNames.forEach(name => {
            const key = canonicalName(name);
            if (!existingByCanonical.has(key)) existingByCanonical.set(key, []);
            existingByCanonical.get(key)?.push(name);
        });

        const targetByCanonical = new Map<string, RenameItem>();
        items.forEach(item => {
            const targetKey = canonicalName(item.newName);
            if (targetByCanonical.has(targetKey)) {
                errors.push(`出力ファイル名「${item.newName}」が重複しています。`);
            } else {
                targetByCanonical.set(targetKey, item);
            }

            const originalKey = canonicalName(item.originalName);
            const existingMatches = existingByCanonical.get(targetKey) || [];
            if (item.noOp) {
                if (existingMatches.length > 1) {
                    errors.push(`「${item.newName}」と大文字小文字またはUnicode表記だけが異なるファイルが存在します。`);
                }
                return;
            }
            if (targetKey === originalKey) {
                errors.push(`「${item.originalName}」は大文字小文字またはUnicode表記だけを変える安全でない変更です。`);
                return;
            }
            if (existingMatches.length > 0) {
                errors.push(`出力先「${item.newName}」はすでに存在します。別フォルダへ移すか名前を変更してください。`);
            }
        });

        return {
            ok: uniqueMessages(errors).length === 0 && items.length > 0,
            errors: uniqueMessages(errors),
            items,
            activeCount: activeRoster.length,
            photoCount: photos.length
        };
    }

    async function listFileEntries(dirHandle: FileSystemDirectoryHandle): Promise<FileEntry[]> {
        const entries: FileEntry[] = [];
        for await (const entry of dirHandle.values()) {
            if (isFileHandle(entry)) entries.push({ name: entry.name, handle: entry });
        }
        return entries;
    }

    async function getExistingFileHandle(dirHandle: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
        try {
            return await dirHandle.getFileHandle(name, { create: false });
        } catch (error) {
            if (errorName(error) === 'NotFoundError') return null;
            throw error;
        }
    }

    async function isSameHandle(left: FileSystemFileHandle | null | undefined, right: FileSystemFileHandle | null | undefined): Promise<boolean> {
        if (!left || !right) return false;
        if (typeof left.isSameEntry === 'function') return left.isSameEntry(right);
        if (typeof right.isSameEntry === 'function') return right.isSameEntry(left);
        return left === right;
    }

    async function filesHaveSameBytes(left: Blob | null | undefined, right: Blob | null | undefined): Promise<boolean> {
        if (!left || !right || left.size !== right.size) return false;

        for (let offset = 0; offset < left.size; offset += BYTE_COMPARE_CHUNK_SIZE) {
            const end = Math.min(offset + BYTE_COMPARE_CHUNK_SIZE, left.size);
            const [leftBuffer, rightBuffer] = await Promise.all([
                left.slice(offset, end).arrayBuffer(),
                right.slice(offset, end).arrayBuffer()
            ]);
            const leftBytes = new Uint8Array(leftBuffer);
            const rightBytes = new Uint8Array(rightBuffer);
            if (leftBytes.length !== rightBytes.length) return false;
            for (let index = 0; index < leftBytes.length; index++) {
                if (leftBytes[index] !== rightBytes[index]) return false;
            }
        }
        return true;
    }

    async function readOwnedFile(dirHandle: FileSystemDirectoryHandle, owned: NamedHandle, label: string): Promise<File> {
        const currentHandle = await getExistingFileHandle(dirHandle, owned.name);
        if (!currentHandle) throw new Error(`${label}「${owned.name}」が処理中に見つからなくなりました。`);
        if (!await isSameHandle(currentHandle, owned.handle)) {
            throw new Error(`${label}「${owned.name}」が処理中に別のファイルへ置き換えられました。`);
        }
        return currentHandle.getFile();
    }

    async function nameExists(dirHandle: FileSystemDirectoryHandle, name: string): Promise<boolean> {
        if (await getExistingFileHandle(dirHandle, name)) return true;
        const key = canonicalName(name);
        const entries = await listFileEntries(dirHandle);
        return entries.some(entry => canonicalName(entry.name) === key);
    }

    async function revalidatePlan(dirHandle: FileSystemDirectoryHandle, items: RenameItem[]): Promise<PreparedItem[]> {
        const entries = await listFileEntries(dirHandle);
        const byExactName = new Map(entries.map(entry => [entry.name, entry]));
        const byCanonical = new Map<string, FileEntry[]>();
        entries.forEach(entry => {
            const key = canonicalName(entry.name);
            if (!byCanonical.has(key)) byCanonical.set(key, []);
            byCanonical.get(key)?.push(entry);
        });

        const targetKeys = new Set<string>();
        const prepared: PreparedItem[] = [];
        for (const item of items) {
            const targetKey = canonicalName(item.newName);
            if (targetKeys.has(targetKey)) throw new Error(`出力ファイル名「${item.newName}」が重複しています。`);
            targetKeys.add(targetKey);

            const sourceEntry = byExactName.get(item.originalName);
            const resolvedSource = await getExistingFileHandle(dirHandle, item.originalName);
            if (!sourceEntry || !resolvedSource) {
                throw new Error(`元ファイル「${item.originalName}」が見つかりません。フォルダを選び直してください。`);
            }
            if (!await isSameHandle(item.handle, sourceEntry.handle)
                || !await isSameHandle(item.handle, resolvedSource)) {
                throw new Error(`元ファイル「${item.originalName}」が選択時から変更されました。`);
            }

            const sourceFile = await item.handle.getFile();
            if (Number.isFinite(item.size) && sourceFile.size !== item.size) {
                throw new Error(`「${item.originalName}」のサイズが選択時から変更されました。`);
            }
            if (Number.isFinite(item.lastModified) && sourceFile.lastModified !== item.lastModified) {
                throw new Error(`「${item.originalName}」の更新日時が選択時から変更されました。`);
            }

            const targetMatches = byCanonical.get(targetKey) || [];
            const resolvedTarget = await getExistingFileHandle(dirHandle, item.newName);
            if (item.noOp) {
                if (!resolvedTarget
                    || !await isSameHandle(resolvedTarget, item.handle)
                    || targetMatches.length !== 1
                    || targetMatches[0]?.name !== item.originalName) {
                    throw new Error(`「${item.newName}」と紛らわしい同名ファイルが存在します。`);
                }
            } else if (resolvedTarget || targetMatches.length > 0) {
                throw new Error(`出力先「${item.newName}」はすでに存在します。`);
            }

            prepared.push({ ...item, sourceFile });
        }
        return prepared;
    }

    async function writeAndVerify(fileHandle: FileSystemFileHandle, sourceFile: Blob): Promise<void> {
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(sourceFile);
            await writable.close();
        } catch (error) {
            if (typeof writable.abort === 'function') {
                try { await writable.abort(); } catch (_) { /* best effort */ }
            }
            throw error;
        }

        const writtenFile = await fileHandle.getFile();
        if (!await filesHaveSameBytes(writtenFile, sourceFile)) {
            throw new Error('書き込み後のファイル内容が元ファイルと一致しません。');
        }
    }

    function createBatchId(): string {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return globalThis.crypto.randomUUID().replace(/-/g, '');
        }
        return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function createReservationFile(batchId: string, index: number, item: Pick<StagedItem, 'originalName' | 'newName' | 'tempName' | 'journalName'>): Blob {
        const record = {
            batchId,
            index,
            originalName: item.originalName,
            newName: item.newName,
            tempName: item.tempName,
            ...(item.journalName ? { journalName: item.journalName } : {})
        };
        return new Blob(
            [RESERVATION_MAGIC, JSON.stringify(record)],
            { type: 'application/octet-stream' }
        );
    }

    async function readReservationRecord(file: Blob | null | undefined): Promise<ReservationRecord | null> {
        if (!file || file.size < RESERVATION_MAGIC.length || file.size > MAX_RESERVATION_BYTES) return null;
        let text: string;
        try {
            const buffer = await file.slice(0, MAX_RESERVATION_BYTES).arrayBuffer();
            text = new TextDecoder().decode(buffer);
        } catch (_) {
            return null;
        }
        if (!text.startsWith(RESERVATION_MAGIC)) return null;

        try {
            const parsed: unknown = JSON.parse(text.slice(RESERVATION_MAGIC.length));
            if (!parsed || typeof parsed !== 'object') return null;
            const record = parsed as Record<string, unknown>;
            const expectedTempName = record && typeof record.batchId === 'string' && Number.isInteger(record.index)
                ? `${TEMP_PREFIX}${record.batchId}_${record.index}.tmp`
                : '';
            const expectedJournalName = record && typeof record.batchId === 'string' && Number.isInteger(record.index)
                ? `${JOURNAL_PREFIX}${record.batchId}_${record.index}.json`
                : '';
            if (!record
                || typeof record.batchId !== 'string'
                || !/^[A-Za-z0-9_]+$/.test(record.batchId)
                || typeof record.index !== 'number'
                || !Number.isInteger(record.index)
                || record.index < 0
                || typeof record.originalName !== 'string'
                || record.originalName.length === 0
                || typeof record.newName !== 'string'
                || record.newName.length === 0
                || typeof record.tempName !== 'string'
                || record.tempName !== expectedTempName
                || (record.journalName !== undefined
                    && (typeof record.journalName !== 'string' || record.journalName !== expectedJournalName))
                || new Set([record.originalName, record.newName, record.tempName]).size !== 3) {
                return null;
            }
            return {
                batchId: record.batchId,
                index: record.index,
                originalName: record.originalName,
                newName: record.newName,
                tempName: record.tempName,
                ...(typeof record.journalName === 'string' ? { journalName: record.journalName } : {})
            };
        } catch (_) {
            return null;
        }
    }

    async function verifyFreshHandle(dirHandle: FileSystemDirectoryHandle, owned: NamedHandle, forbiddenHandles: readonly FileSystemFileHandle[]): Promise<void> {
        const currentHandle = await getExistingFileHandle(dirHandle, owned.name);
        if (!currentHandle || !await isSameHandle(currentHandle, owned.handle)) {
            throw new Error(`「${owned.name}」を安全に作成できませんでした。`);
        }
        for (const forbiddenHandle of forbiddenHandles) {
            if (await isSameHandle(currentHandle, forbiddenHandle)) {
                throw new Error(`「${owned.name}」が既存ファイルと同じ保存先を指しています。処理を中止しました。`);
            }
        }
        const file = await currentHandle.getFile();
        if (file.size !== 0) {
            throw new Error(`「${owned.name}」が作成直前に別のファイルとして用意されました。上書きせず中止しました。`);
        }
    }

    async function cleanupOwnedEntries(dirHandle: FileSystemDirectoryHandle, entries: readonly OwnedEntry[]): Promise<string[]> {
        const warnings: string[] = [];
        for (const entry of [...entries].reverse()) {
            try {
                const currentHandle = await getExistingFileHandle(dirHandle, entry.name);
                if (!currentHandle) continue;
                if (!await isSameHandle(currentHandle, entry.handle)) {
                    warnings.push(`${entry.name}: 別のファイルへ置き換えられたため削除しませんでした`);
                    continue;
                }
                const referenceFiles = entry.referenceFiles
                    || (entry.referenceFile ? [entry.referenceFile] : []);
                if (referenceFiles.length > 0) {
                    const currentFile = await currentHandle.getFile();
                    const allowedEmpty = entry.allowEmpty === true && currentFile.size === 0;
                    let matchesReference = allowedEmpty;
                    for (const referenceFile of referenceFiles) {
                        if (!matchesReference && await filesHaveSameBytes(currentFile, referenceFile)) {
                            matchesReference = true;
                        }
                    }
                    if (!matchesReference) {
                        warnings.push(`${entry.name}: 内容が処理中に変わったため削除しませんでした`);
                        continue;
                    }
                }
                if (typeof entry.handle.remove !== 'function') {
                    warnings.push(`${entry.name}: このブラウザでは安全な削除を確認できないため残しました`);
                    continue;
                }
                await entry.handle.remove();
            } catch (error) {
                if (errorName(error) !== 'NotFoundError') warnings.push(`${entry.name}: ${errorMessage(error)}`);
            }
        }
        return warnings;
    }

    async function verifyBeforeOriginalRemoval(dirHandle: FileSystemDirectoryHandle, item: PublishedItem): Promise<File> {
        const sourceFile = await readOwnedFile(
            dirHandle,
            { name: item.originalName, handle: item.handle },
            '元ファイル'
        );
        if (Number.isFinite(item.size) && sourceFile.size !== item.size) {
            throw new Error(`元ファイル「${item.originalName}」のサイズが処理中に変更されました。`);
        }
        if (Number.isFinite(item.lastModified) && sourceFile.lastModified !== item.lastModified) {
            throw new Error(`元ファイル「${item.originalName}」の更新日時が処理中に変更されました。`);
        }

        const tempFile = await readOwnedFile(
            dirHandle,
            { name: item.tempName, handle: item.tempHandle },
            '一時ファイル'
        );
        const finalFile = await readOwnedFile(
            dirHandle,
            { name: item.newName, handle: item.finalHandle },
            '出力ファイル'
        );
        if (!await filesHaveSameBytes(sourceFile, tempFile)
            || !await filesHaveSameBytes(finalFile, tempFile)) {
            throw new Error(`「${item.originalName}」の複製内容が一致しないため、原本を残しました。`);
        }
        return tempFile;
    }

    async function restoreOriginalFromTemp(dirHandle: FileSystemDirectoryHandle, item: PublishedItem, tempFile: File, forbiddenHandles: readonly FileSystemFileHandle[]): Promise<RestoreOutcome> {
        if (await nameExists(dirHandle, item.originalName)) {
            return { restored: false, warning: `元ファイル名「${item.originalName}」に別のファイルがあるため、自動復元せず一時ファイルを残しました。` };
        }

        const restoredHandle = await dirHandle.getFileHandle(item.originalName, { create: true });
        const owned = { name: item.originalName, handle: restoredHandle };
        let ownershipConfirmed = false;
        try {
            await verifyFreshHandle(dirHandle, owned, forbiddenHandles);
            ownershipConfirmed = true;
            await writeAndVerify(restoredHandle, tempFile);
            return {
                restored: true,
                handle: restoredHandle,
                warning: `出力ファイルを確認できなかったため、「${item.originalName}」を一時ファイルから復元しました。`
            };
        } catch (error) {
            if (ownershipConfirmed) {
                try {
                    const currentFile = await readOwnedFile(dirHandle, owned, '復元ファイル');
                    if (await filesHaveSameBytes(currentFile, tempFile)) {
                        return {
                            restored: true,
                            handle: restoredHandle,
                            warning: `「${item.originalName}」を復元しましたが、書き込み完了の確認中に警告が発生しました（${errorMessage(error)}）。`
                        };
                    }
                } catch (_) { /* 復元済みか確認できないため後片付けを試みる */ }
            } else {
                return {
                    restored: false,
                    warning: `「${item.originalName}」の復元先を安全に所有できませんでした。一時ファイルを残しています（${errorMessage(error)}）。`
                };
            }

            // close失敗時は実ファイルが空・部分書き込み・外部更新のどれかを判別できない。
            // 空、または完全復元済みと証明できる内容以外は安全側で残す。
            const cleanupWarnings = await cleanupOwnedEntries(dirHandle, [{
                ...owned,
                referenceFile: tempFile,
                allowEmpty: true
            }]);
            const cleanupDetail = cleanupWarnings.length > 0
                ? ` 復元途中のファイルも削除できませんでした（${cleanupWarnings.join('、')}）。`
                : '';
            return {
                restored: false,
                warning: `「${item.originalName}」の自動復元に失敗しました。一時ファイルを残しています（${errorMessage(error)}）。${cleanupDetail}`
            };
        }
    }

    async function cleanupTempWithDurableCopy(dirHandle: FileSystemDirectoryHandle, item: PublishedItem, durableEntries: readonly DurableEntry[]): Promise<string[]> {
        let tempFile: File;
        try {
            tempFile = await readOwnedFile(
                dirHandle,
                { name: item.tempName, handle: item.tempHandle },
                '一時ファイル'
            );
        } catch (error) {
            return [`${item.tempName}: ${errorMessage(error)}`];
        }

        let durableCopyFound = false;
        for (const entry of durableEntries) {
            try {
                if (await isSameHandle(entry.handle, item.tempHandle)) continue;
                const durableFile = await readOwnedFile(dirHandle, entry, '保存先ファイル');
                if (await filesHaveSameBytes(durableFile, tempFile)) {
                    durableCopyFound = true;
                    break;
                }
            } catch (_) { /* 別の候補を確認する */ }
        }

        if (!durableCopyFound) {
            return [`${item.tempName}: 正常な保存先を再確認できないため一時ファイルを残しました`];
        }
        return cleanupOwnedEntries(dirHandle, [{
            name: item.tempName,
            handle: item.tempHandle,
            referenceFile: tempFile
        }]);
    }

    async function cleanupOwnedEntryWithLiveSource(dirHandle: FileSystemDirectoryHandle, item: PreparedItem, ownedEntry: OwnedEntry): Promise<string[]> {
        try {
            if (await isSameHandle(item.handle, ownedEntry.handle)) {
                return [`${ownedEntry.name}: 元ファイルと同じ保存先を指すため削除しませんでした`];
            }
            if (ownedEntry.allowEmpty === true) {
                const ownedFile = await readOwnedFile(dirHandle, ownedEntry, '後片付け対象');
                if (ownedFile.size === 0) {
                    return cleanupOwnedEntries(dirHandle, [{ ...ownedEntry, allowEmpty: true }]);
                }
            }
            const currentSource = await readOwnedFile(
                dirHandle,
                { name: item.originalName, handle: item.handle },
                '元ファイル'
            );
            if (!await filesHaveSameBytes(currentSource, item.sourceFile)) {
                return [`${ownedEntry.name}: 正常な元ファイルを再確認できないため削除しませんでした`];
            }
        } catch (error) {
            return [`${ownedEntry.name}: 元ファイルを再確認できないため削除しませんでした（${errorMessage(error)}）`];
        }
        return cleanupOwnedEntries(dirHandle, [ownedEntry]);
    }

    async function cleanupJournalWithDurableEntry(dirHandle: FileSystemDirectoryHandle, item: PublishedItem, durableEntries: readonly DurableEntry[]): Promise<string[]> {
        let durableEntryFound = false;
        for (const entry of durableEntries) {
            try {
                if (await isSameHandle(entry.handle, item.journalHandle)) continue;
                await readOwnedFile(dirHandle, entry, '保存先ファイル');
                durableEntryFound = true;
                break;
            } catch (_) { /* 別の候補を確認する */ }
        }
        if (!durableEntryFound) {
            return [`${item.journalName}: 正常な保存先を再確認できないため復旧台帳を残しました`];
        }
        return cleanupOwnedEntries(dirHandle, [{
            name: item.journalName,
            handle: item.journalHandle,
            referenceFile: item.reservationFile
        }]);
    }

    function reservationRecordsMatch(left: ReservationRecord | null | undefined, right: ReservationRecord | null | undefined): boolean {
        return Boolean(left && right
            && left.batchId === right.batchId
            && left.index === right.index
            && left.originalName === right.originalName
            && left.newName === right.newName
            && left.tempName === right.tempName
            && left.journalName === right.journalName);
    }

    async function assertHandlesAreDistinct(entries: readonly LabeledHandle[]): Promise<void> {
        const existing = entries.filter((entry): entry is { label: string; handle: FileSystemFileHandle } => entry.handle !== null);
        for (let leftIndex = 0; leftIndex < existing.length; leftIndex++) {
            for (let rightIndex = leftIndex + 1; rightIndex < existing.length; rightIndex++) {
                const left = existing[leftIndex];
                const right = existing[rightIndex];
                if (left && right && await isSameHandle(left.handle, right.handle)) {
                    throw new Error(`${left.label}と${right.label}が同じ保存先を指しているため、何も削除しません。`);
                }
            }
        }
    }

    async function removeOwnedOrThrow(dirHandle: FileSystemDirectoryHandle, entry: OwnedEntry): Promise<void> {
        const cleanupWarnings = await cleanupOwnedEntries(dirHandle, [entry]);
        if (cleanupWarnings.length > 0) throw new Error(cleanupWarnings.join('、'));
    }

    async function recoverLegacyReservation(dirHandle: FileSystemDirectoryHandle, reservation: Pick<ReservationEntry, 'name' | 'handle'>, markerFile: File, record: ReservationRecord): Promise<void> {
        const originalHandle = await getExistingFileHandle(dirHandle, record.originalName);
        const tempHandle = await getExistingFileHandle(dirHandle, record.tempName);
        if (!originalHandle || !tempHandle) {
            throw new Error('対応する原本または一時ファイルが見つかりません。');
        }
        await assertHandlesAreDistinct([
            { label: '原本', handle: originalHandle },
            { label: '一時ファイル', handle: tempHandle },
            { label: '予約ファイル', handle: reservation.handle }
        ]);
        const [originalFile, tempFile] = await Promise.all([
            originalHandle.getFile(),
            tempHandle.getFile()
        ]);
        if (!await filesHaveSameBytes(originalFile, tempFile)) {
            throw new Error('原本と一時ファイルの内容が一致しません。');
        }

        await removeOwnedOrThrow(dirHandle, {
            name: reservation.name,
            handle: reservation.handle,
            referenceFile: markerFile
        });

        const [currentOriginalFile, currentTempFile] = await Promise.all([
            readOwnedFile(
                dirHandle,
                { name: record.originalName, handle: originalHandle },
                '原本'
            ),
            readOwnedFile(
                dirHandle,
                { name: record.tempName, handle: tempHandle },
                '一時ファイル'
            )
        ]);
        if (!await filesHaveSameBytes(currentOriginalFile, currentTempFile)) {
            throw new Error('マーカー削除後に原本と一時ファイルの一致を確認できませんでした。一時ファイルは残しています。');
        }
        await removeOwnedOrThrow(dirHandle, {
            name: record.tempName,
            handle: tempHandle,
            referenceFile: currentTempFile
        });
    }

    async function recoverJournalReservation(dirHandle: FileSystemDirectoryHandle, reservation: Pick<ReservationEntry, 'name' | 'handle'>, journalFile: File, record: ReservationRecord): Promise<void> {
        const [originalHandle, tempHandle, finalHandle] = await Promise.all([
            getExistingFileHandle(dirHandle, record.originalName),
            getExistingFileHandle(dirHandle, record.tempName),
            getExistingFileHandle(dirHandle, record.newName)
        ]);
        await assertHandlesAreDistinct([
            { label: '原本', handle: originalHandle },
            { label: '一時ファイル', handle: tempHandle },
            { label: '出力ファイル', handle: finalHandle },
            { label: '復旧台帳', handle: reservation.handle }
        ]);

        if (tempHandle) {
            const tempFile = await tempHandle.getFile();
            if (originalHandle) {
                const originalFile = await originalHandle.getFile();
                if (tempFile.size === 0 && !finalHandle) {
                    await removeOwnedOrThrow(dirHandle, {
                        name: record.tempName,
                        handle: tempHandle,
                        referenceFile: tempFile,
                        allowEmpty: true
                    });
                    await readOwnedFile(
                        dirHandle,
                        { name: record.originalName, handle: originalHandle },
                        '原本'
                    );
                    await removeOwnedOrThrow(dirHandle, {
                        name: reservation.name,
                        handle: reservation.handle,
                        referenceFile: journalFile
                    });
                    return;
                }
                if (!await filesHaveSameBytes(originalFile, tempFile)) {
                    throw new Error('原本と一時ファイルの内容が一致しません。');
                }

                if (finalHandle) {
                    const finalFile = await finalHandle.getFile();
                    const finalRecord = await readReservationRecord(finalFile);
                    const isOwnedMarker = reservationRecordsMatch(finalRecord, record);
                    if (!isOwnedMarker && !await filesHaveSameBytes(finalFile, tempFile)) {
                        throw new Error('出力ファイルが予約記録または一時ファイルと一致しないため、何も削除しません。');
                    }
                    await removeOwnedOrThrow(dirHandle, {
                        name: record.newName,
                        handle: finalHandle,
                        referenceFile: finalFile
                    });
                }

                const [currentOriginalFile, currentTempFile] = await Promise.all([
                    readOwnedFile(
                        dirHandle,
                        { name: record.originalName, handle: originalHandle },
                        '原本'
                    ),
                    readOwnedFile(
                        dirHandle,
                        { name: record.tempName, handle: tempHandle },
                        '一時ファイル'
                    )
                ]);
                if (!await filesHaveSameBytes(currentOriginalFile, currentTempFile)) {
                    throw new Error('出力先の片付け後に原本と一時ファイルの一致を確認できませんでした。一時ファイルは残しています。');
                }
                await removeOwnedOrThrow(dirHandle, {
                    name: record.tempName,
                    handle: tempHandle,
                    referenceFile: currentTempFile
                });
            } else {
                if (!finalHandle) {
                    throw new Error('原本がなく、一時ファイル以外の正常コピーを確認できないため何も削除しません。');
                }
                const finalFile = await finalHandle.getFile();
                if (!await filesHaveSameBytes(finalFile, tempFile)) {
                    throw new Error('原本がなく、出力ファイルと一時ファイルも一致しないため何も削除しません。');
                }
                const [currentFinalFile, currentTempFile] = await Promise.all([
                    readOwnedFile(
                        dirHandle,
                        { name: record.newName, handle: finalHandle },
                        '出力ファイル'
                    ),
                    readOwnedFile(
                        dirHandle,
                        { name: record.tempName, handle: tempHandle },
                        '一時ファイル'
                    )
                ]);
                if (!await filesHaveSameBytes(currentFinalFile, currentTempFile)) {
                    throw new Error('一時ファイル削除前に出力内容を再確認できませんでした。');
                }
                await removeOwnedOrThrow(dirHandle, {
                    name: record.tempName,
                    handle: tempHandle,
                    referenceFile: currentTempFile
                });
            }
        } else if (originalHandle && finalHandle) {
            const [originalFile, finalFile] = await Promise.all([
                originalHandle.getFile(),
                finalHandle.getFile()
            ]);
            const finalRecord = await readReservationRecord(finalFile);
            if (!reservationRecordsMatch(finalRecord, record)
                && !await filesHaveSameBytes(originalFile, finalFile)) {
                throw new Error('一時ファイルがなく、原本と出力ファイルも一致しないため何も削除しません。');
            }
            await removeOwnedOrThrow(dirHandle, {
                name: record.newName,
                handle: finalHandle,
                referenceFile: finalFile
            });
            await readOwnedFile(
                dirHandle,
                { name: record.originalName, handle: originalHandle },
                '原本'
            );
        } else if (!originalHandle && finalHandle) {
            const finalFile = await finalHandle.getFile();
            const finalRecord = await readReservationRecord(finalFile);
            if (reservationRecordsMatch(finalRecord, record)) {
                throw new Error('写真本体が見つからず予約マーカーだけが残っているため、復旧台帳を保持します。');
            }
            // 出力画像だけが残る完了直後の中断。データには触れず台帳だけを片付ける。
        } else if (!originalHandle) {
            throw new Error('原本・出力ファイル・一時ファイルが見つからないため、復旧台帳を保持します。');
        }

        await removeOwnedOrThrow(dirHandle, {
            name: reservation.name,
            handle: reservation.handle,
            referenceFile: journalFile
        });
    }

    async function recoverInterruptedReservations(options: RecoverOptions = {}): Promise<RecoverOutcome> {
        const { dirHandle, reservations = [] } = options;
        if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') {
            throw new Error('写真フォルダが選択されていません。');
        }

        const recovered: Array<Pick<ReservationRecord, 'originalName' | 'newName'>> = [];
        const warnings: string[] = [];
        for (const reservation of reservations) {
            try {
                const markerFile = await readOwnedFile(
                    dirHandle,
                    { name: reservation.name, handle: reservation.handle },
                    '予約ファイル'
                );
                const record = await readReservationRecord(markerFile);
                const isJournal = Boolean(record?.journalName && record.journalName === reservation.name);
                const isLegacyMarker = Boolean(record && record.newName === reservation.name);
                if (!isJournal && !isLegacyMarker) {
                    throw new Error('アプリが作成した予約ファイルとして確認できません。');
                }

                if (!record) throw new Error('アプリが作成した予約ファイルとして確認できません。');
                if (isJournal) {
                    await recoverJournalReservation(dirHandle, reservation, markerFile, record);
                } else {
                    await recoverLegacyReservation(dirHandle, reservation, markerFile, record);
                }
                recovered.push({ originalName: record.originalName, newName: record.newName });
            } catch (error) {
                warnings.push(`${reservation.name}: ${errorMessage(error)}`);
            }
        }

        return { recovered, warnings, clean: warnings.length === 0 };
    }

    function notifyProgress(callback: ProgressCallback | undefined, detail: ProgressDetail): void {
        if (typeof callback !== 'function') return;
        try { callback(detail); } catch (_) { /* UI callback must not affect file safety */ }
    }

    async function executeSafeRenameBatch(options: SafeRenameOptions = {}): Promise<RenameOutcome> {
        const { dirHandle, items = [], onProgress } = options;
        if (!dirHandle || typeof dirHandle.values !== 'function') throw new Error('写真フォルダが選択されていません。');
        if (!Array.isArray(items) || items.length === 0) throw new Error('リネーム対象がありません。');

        const immutableItems = items.map(item => ({ ...item }));
        notifyProgress(onProgress, { phase: 'validate', current: 0, total: immutableItems.length });
        const prepared = await revalidatePlan(dirHandle, immutableItems);
        const changing = prepared.filter(item => !item.noOp);
        const unchanged = prepared.filter(item => item.noOp);

        const unsupportedRemoval = changing.find(item => typeof item.handle?.remove !== 'function');
        if (unsupportedRemoval) {
            throw new Error('このブラウザは原本を安全に削除できません。最新版のChromeまたはEdgeへ更新してください。');
        }

        if (changing.length === 0) {
            return {
                results: unchanged.map(item => ({
                    success: true,
                    status: 'unchanged',
                    unchanged: true,
                    original: item.originalName,
                    newName: item.newName
                })),
                warnings: [],
                clean: true
            };
        }

        const batchId = createBatchId();
        const staged: StagedItem[] = [];
        const journals: JournalEntry[] = [];
        const published: PublishedItem[] = [];
        const sourceHandles = prepared.map(item => item.handle);

        try {
            for (const [index, item] of changing.entries()) {
                const tempName = `${TEMP_PREFIX}${batchId}_${index}.tmp`;
                const journalName = `${JOURNAL_PREFIX}${batchId}_${index}.json`;
                if (await nameExists(dirHandle, tempName)) {
                    throw new Error('一時ファイル名が衝突しました。もう一度実行してください。');
                }
                if (await nameExists(dirHandle, journalName)) {
                    throw new Error('復旧台帳のファイル名が衝突しました。もう一度実行してください。');
                }

                const reservationFile = createReservationFile(batchId, index, { ...item, tempName, journalName });

                // 一時コピーより先に台帳を耐久化し、staging中の中断も自動復旧できるようにする。
                const journalHandle = await dirHandle.getFileHandle(journalName, { create: true });
                await verifyFreshHandle(
                    dirHandle,
                    { name: journalName, handle: journalHandle },
                    [
                        ...sourceHandles,
                        ...staged.map(entry => entry.tempHandle),
                        ...journals.map(entry => entry.handle)
                    ]
                );
                await writeAndVerify(journalHandle, reservationFile);

                const tempHandle = await dirHandle.getFileHandle(tempName, { create: true });
                const stagedItem: StagedItem = {
                    ...item,
                    tempName,
                    journalName,
                    tempHandle,
                    journalHandle,
                    reservationFile,
                    ownershipConfirmed: false
                };
                const journal: JournalEntry = { item: stagedItem, name: journalName, handle: journalHandle, ownershipConfirmed: true };
                journals.push(journal);
                staged.push(stagedItem);
                await verifyFreshHandle(
                    dirHandle,
                    { name: tempName, handle: tempHandle },
                    [
                        ...sourceHandles,
                        ...journals.map(entry => entry.handle),
                        ...staged.slice(0, -1).map(entry => entry.tempHandle)
                    ]
                );
                stagedItem.ownershipConfirmed = true;
                notifyProgress(onProgress, { phase: 'stage', current: index + 1, total: changing.length });
                await writeAndVerify(tempHandle, item.sourceFile);
            }
        } catch (error) {
            const unconfirmedWarnings = staged
                .filter(item => !item.ownershipConfirmed)
                .map(item => `${item.tempName}: 所有確認に失敗したため削除していません`);
            const cleanupWarnings: string[] = [];
            for (const item of staged.filter(entry => entry.ownershipConfirmed)) {
                cleanupWarnings.push(...await cleanupOwnedEntryWithLiveSource(dirHandle, item, {
                    name: item.tempName,
                    handle: item.tempHandle,
                    referenceFile: item.sourceFile,
                    allowEmpty: true
                }));
            }
            const unconfirmedJournalWarnings = journals
                .filter(journal => !journal.ownershipConfirmed)
                .map(journal => `${journal.name}: 所有確認に失敗したため削除していません`);
            const journalWarnings: string[] = [];
            for (const journal of journals.filter(entry => entry.ownershipConfirmed)) {
                const [remainingTemp, remainingFinal] = await Promise.all([
                    getExistingFileHandle(dirHandle, journal.item.tempName),
                    getExistingFileHandle(dirHandle, journal.item.newName)
                ]);
                if (remainingTemp || remainingFinal) {
                    journalWarnings.push(`${journal.name}: 一時ファイルまたは出力先が残っているため復旧台帳も残しました`);
                    continue;
                }
                journalWarnings.push(...await cleanupOwnedEntries(dirHandle, [{
                    name: journal.name,
                    handle: journal.handle,
                    referenceFile: journal.item.reservationFile
                }]));
            }
            const failure = toRenameFailure(error);
            failure.cleanupWarnings = [
                ...unconfirmedWarnings,
                ...unconfirmedJournalWarnings,
                ...cleanupWarnings,
                ...journalWarnings
            ];
            if (failure.cleanupWarnings.length === 0) delete failure.cleanupWarnings;
            throw failure;
        }

        try {
            // すべての出力先を空の状態で予約してから書き込み、別名が同じ実体を指す場合も検出する。
            for (const item of staged) {
                if (await nameExists(dirHandle, item.newName)) {
                    throw new Error(`出力先「${item.newName}」が処理中に作成されました。原本は変更していません。`);
                }
                const finalHandle = await dirHandle.getFileHandle(item.newName, { create: true });
                const publishedItem: PublishedItem = {
                    ...item,
                    finalHandle,
                    ownershipConfirmed: false,
                    finalWritten: false,
                    resultStatus: 'pending'
                };
                published.push(publishedItem);
                await verifyFreshHandle(
                    dirHandle,
                    { name: item.newName, handle: finalHandle },
                    [
                        ...sourceHandles,
                        ...staged.map(entry => entry.tempHandle),
                        ...published.slice(0, -1).map(entry => entry.finalHandle)
                    ]
                );
                // 排他的createがないため、固有マーカーを書いて直後の外部更新を検出する。
                await writeAndVerify(finalHandle, item.reservationFile);
                publishedItem.ownershipConfirmed = true;
            }

            for (const [index, item] of published.entries()) {
                notifyProgress(onProgress, { phase: 'publish', current: index + 1, total: staged.length });
                const reservationFile = await readOwnedFile(
                    dirHandle,
                    { name: item.newName, handle: item.finalHandle },
                    '出力ファイル'
                );
                if (!await filesHaveSameBytes(reservationFile, item.reservationFile)) {
                    throw new Error(`出力先「${item.newName}」の内容が処理中に変わりました。原本は変更していません。`);
                }
                const tempFile = await readOwnedFile(
                    dirHandle,
                    { name: item.tempName, handle: item.tempHandle },
                    '一時ファイル'
                );
                await writeAndVerify(item.finalHandle, tempFile);
                item.finalWritten = true;
            }
        } catch (error) {
            const unconfirmedWarnings = published
                .filter(item => !item.ownershipConfirmed)
                .map(item => `${item.newName}: 所有確認に失敗したため削除していません`);
            const finalWarnings: string[] = [];
            for (const item of published.filter(entry => entry.ownershipConfirmed)) {
                finalWarnings.push(...await cleanupOwnedEntryWithLiveSource(dirHandle, item, {
                    name: item.newName,
                    handle: item.finalHandle,
                    referenceFiles: [item.reservationFile, item.sourceFile]
                }));
            }
            const tempWarnings: string[] = [];
            for (const item of staged) {
                tempWarnings.push(...await cleanupOwnedEntryWithLiveSource(dirHandle, item, {
                    name: item.tempName,
                    handle: item.tempHandle,
                    referenceFile: item.sourceFile,
                    allowEmpty: true
                }));
            }
            const unconfirmedJournalWarnings = journals
                .filter(journal => !journal.ownershipConfirmed)
                .map(journal => `${journal.name}: 所有確認に失敗したため削除していません`);
            const journalWarnings: string[] = [];
            for (const journal of journals.filter(entry => entry.ownershipConfirmed)) {
                const [remainingTemp, remainingFinal] = await Promise.all([
                    getExistingFileHandle(dirHandle, journal.item.tempName),
                    getExistingFileHandle(dirHandle, journal.item.newName)
                ]);
                if (remainingTemp || remainingFinal) {
                    journalWarnings.push(`${journal.name}: 一時ファイルまたは出力先が残っているため復旧台帳も残しました`);
                    continue;
                }
                journalWarnings.push(...await cleanupOwnedEntries(dirHandle, [{
                    name: journal.name,
                    handle: journal.handle,
                    referenceFile: journal.item.reservationFile
                }]));
            }
            const cleanupWarnings: string[] = [
                ...unconfirmedWarnings,
                ...unconfirmedJournalWarnings,
                ...finalWarnings,
                ...tempWarnings,
                ...journalWarnings
            ];
            const failure = toRenameFailure(error);
            if (cleanupWarnings.length > 0) failure.cleanupWarnings = cleanupWarnings;
            throw failure;
        }

        const warnings: string[] = [];
        const removableTemps: RemovableTemp[] = [];
        for (const [index, item] of published.entries()) {
            notifyProgress(onProgress, { phase: 'cleanup', current: index + 1, total: published.length });
            let tempFile: File;
            try {
                tempFile = await verifyBeforeOriginalRemoval(dirHandle, item);
                if (typeof item.handle.remove !== 'function') {
                    throw new Error('このブラウザでは安全な原本削除を確認できません。');
                }
                // File System Access APIに比較付き削除はないため、直前検証後すぐハンドル指定で削除する。
                await item.handle.remove();
            } catch (error) {
                item.resultStatus = 'partial';
                item.resultMessage = '原本を残しました。新旧両方を確認してください。';
                warnings.push(`元ファイル「${item.originalName}」を削除しませんでした。新旧両方のファイルを確認してください（${errorMessage(error)}）。`);
                removableTemps.push({
                    item,
                    durableEntries: [
                        { name: item.originalName, handle: item.handle },
                        { name: item.newName, handle: item.finalHandle }
                    ]
                });
                continue;
            }

            try {
                const finalFile = await readOwnedFile(
                    dirHandle,
                    { name: item.newName, handle: item.finalHandle },
                    '出力ファイル'
                );
                if (!await filesHaveSameBytes(finalFile, tempFile)) {
                    throw new Error('出力ファイルの内容が処理中に変わりました。');
                }
                item.resultStatus = 'success';
                removableTemps.push({
                    item,
                    durableEntries: [{ name: item.newName, handle: item.finalHandle }]
                });
            } catch (error) {
                const restoration = await restoreOriginalFromTemp(
                    dirHandle,
                    item,
                    tempFile,
                    [item.tempHandle, item.finalHandle, ...sourceHandles.filter(handle => handle !== item.handle)]
                );
                item.resultStatus = restoration.restored ? 'restored' : 'failed';
                item.resultMessage = restoration.restored
                    ? '原名へ復元しました。出力先を確認してください。'
                    : '自動復元できませんでした。一時ファイルを保管しています。';
                warnings.push(`${errorMessage(error)} ${restoration.warning}`);
                if (restoration.restored && restoration.handle) {
                    removableTemps.push({
                        item,
                        durableEntries: [{ name: item.originalName, handle: restoration.handle }]
                    });
                }
            }
        }

        const tempWarnings: string[] = [];
        const journalWarnings: string[] = [];
        for (const candidate of removableTemps) {
            tempWarnings.push(...await cleanupTempWithDurableCopy(
                dirHandle,
                candidate.item,
                candidate.durableEntries
            ));
            if (!await getExistingFileHandle(dirHandle, candidate.item.tempName)) {
                journalWarnings.push(...await cleanupJournalWithDurableEntry(
                    dirHandle,
                    candidate.item,
                    candidate.durableEntries
                ));
            }
        }
        warnings.push(...tempWarnings.map(message => `一時ファイルを削除できませんでした（${message}）。`));
        warnings.push(...journalWarnings.map(message => `復旧台帳を削除できませんでした（${message}）。`));

        const results: ExecutionResult[] = [
            ...published.map<ExecutionResult>(item => ({
                success: item.resultStatus === 'success',
                status: item.resultStatus,
                unchanged: false,
                original: item.originalName,
                newName: item.newName,
                message: item.resultMessage || ''
            })),
            ...unchanged.map<ExecutionResult>(item => ({
                success: true,
                status: 'unchanged',
                unchanged: true,
                original: item.originalName,
                newName: item.newName,
                message: ''
            }))
        ].sort((a, b) => {
                const left = prepared.findIndex(item => item.originalName === a.original);
                const right = prepared.findIndex(item => item.originalName === b.original);
                return left - right;
            });

        return {
            results,
            warnings,
            clean: warnings.length === 0 && results.every(result => result.success)
        };
    }

export {
    IMAGE_EXTS,
        MAX_FILE_NAME_BYTES,
        TEMP_PREFIX,
        JOURNAL_PREFIX,
        RESERVATION_MAGIC,
        isImageFile,
        getExtension,
        naturalCompare,
        canonicalName,
        parseNameList,
        validateStartNumber,
        validateComponent,
        validateFileName,
        buildRenamePlan,
        executeSafeRenameBatch,
        readReservationRecord,
        recoverInterruptedReservations
};

export type {
    ExecutionResult,
    ProgressDetail,
    RecoverOutcome,
    RenameItem,
    RenameOutcome,
    RenamePlan,
    ReservationEntry,
    ReservationRecord
};
