import * as Core from './photo-rename-core';

    type PhotoFile = {
        handle: FileSystemFileHandle;
        name: string;
        url: string;
        size: number;
        lastModified: number;
        previewFailed: boolean | null;
    };
    type ReservationView = Core.ReservationEntry;
    type DirectorySnapshot = {
        photos: PhotoFile[];
        allNames: string[];
        unsupported: string[];
        tempFiles: string[];
        reservations: ReservationView[];
        invalidJournals: string[];
    };
    type SnapshotOptions = { keepRecoveryStatus?: boolean; clearSkips?: boolean };
    type RenameFailure = Error & { cleanupWarnings?: string[] };

    function $(selector: string): HTMLElement {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`必要な画面要素が見つかりません: ${selector}`);
        return element;
    }

    function $$(selector: string): NodeListOf<HTMLElement> {
        return document.querySelectorAll<HTMLElement>(selector);
    }

    function byId<T extends HTMLElement>(id: string): T {
        const element = document.getElementById(id);
        if (!(element instanceof HTMLElement)) throw new Error(`必要な画面要素が見つかりません: #${id}`);
        return element as T;
    }

    function errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    function errorName(error: unknown): string | undefined {
        return error instanceof Error ? error.name : undefined;
    }

    function getRenameFailure(error: unknown): RenameFailure | null {
        return error instanceof Error ? error as RenameFailure : null;
    }

    function isFileSystemFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
        return handle.kind === 'file';
    }
    const UNSUPPORTED_PREVIEW_EXTS = new Set(['heic', 'heif', 'tiff', 'tif']);

    const gradeEl = byId<HTMLInputElement>('grade');
    const classEl = byId<HTMLInputElement>('classNum');
    const startNumEl = byId<HTMLInputElement>('startNum');
    const nameInput = byId<HTMLTextAreaElement>('nameInput');
    const nameListPreview = byId<HTMLElement>('nameListPreview');
    const nameCountEl = byId<HTMLElement>('nameCount');
    const validationMessage = byId<HTMLElement>('validationMessage');
    const selectFolderBtn = byId<HTMLButtonElement>('selectFolderBtn');
    const folderInfo = byId<HTMLElement>('folderInfo');
    const recoverInterruptedBtn = byId<HTMLButtonElement>('recoverInterruptedBtn');
    const recoveryStatus = byId<HTMLElement>('recoveryStatus');
    const photoGrid = byId<HTMLElement>('photoGrid');
    const photoCountEl = byId<HTMLElement>('photoCount');
    const step4 = byId<HTMLElement>('step4');
    const warningBox = byId<HTMLElement>('warningBox');
    const pairList = byId<HTMLElement>('pairList');
    const renameBtn = byId<HTMLButtonElement>('renameBtn');
    const resultSection = byId<HTMLElement>('resultSection');
    const resultList = byId<HTMLElement>('resultList');
    const resultBadge = byId<HTMLElement>('resultBadge');
    const resultTitleIcon = byId<HTMLElement>('resultTitleIcon');
    const confirmModal = byId<HTMLElement>('confirmModal');
    const confirmDialog = confirmModal.querySelector<HTMLElement>('.confirm-modal');
    const confirmMessage = byId<HTMLElement>('confirmMessage');
    const confirmCancel = byId<HTMLButtonElement>('confirmCancel');
    const confirmOk = byId<HTMLButtonElement>('confirmOk');
    const siteWrapper = $('.site-wrapper');
    const classModeToggle = document.getElementById('classModeToggle') as HTMLInputElement | null;

    let dirHandle: FileSystemDirectoryHandle | null = null;
    let photoFiles: PhotoFile[] = [];
    let directoryEntryNames: string[] = [];
    let unsupportedFiles: string[] = [];
    let leftoverTempFiles: string[] = [];
    let interruptedReservations: ReservationView[] = [];
    let invalidJournalFiles: string[] = [];
    let nameList: string[] = [];
    let nameParseErrors: string[] = [];
    let skipNameSet = new Set<number>();
    let dragIdx: number | null = null;
    let isBusy = false;
    let isConfirmOpen = false;
    let batchCompleted = false;
    let currentPlan: Core.RenamePlan | null = null;
    let pendingPlanItems: Core.RenameItem[] | null = null;
    let planRevision = 0;
    let pendingPlanRevision: number | null = null;
    let modalReturnFocus: Element | null = null;
    let directoryStateStale = false;

    function createIcon(className: string): HTMLElement {
        const icon = document.createElement('i');
        icon.className = className;
        icon.setAttribute('aria-hidden', 'true');
        return icon;
    }

    function setButtonContent(button: HTMLElement, iconClass: string, text: string): void {
        button.replaceChildren(createIcon(iconClass), document.createTextNode(` ${text}`));
    }

    function setRenameButtonDefault() {
        setButtonContent(renameBtn, 'fas fa-pen', 'リネーム実行');
    }

    function revokePhotoUrls(photos: readonly PhotoFile[]): void {
        photos.forEach(photo => {
            if (photo.url) URL.revokeObjectURL(photo.url);
        });
    }

    function clearResultForNewPlan() {
        if (isBusy) return;
        batchCompleted = false;
        resultSection.style.display = 'none';
        resultList.replaceChildren();
        setRenameButtonDefault();
    }

    function markPlanChanged() {
        planRevision += 1;
    }

    function interactionLocked() {
        return isBusy || isConfirmOpen;
    }

    function showValidationMessages(messages: readonly string[], focus = false): void {
        const unique = [...new Set(messages.filter(message => message.length > 0))];
        validationMessage.replaceChildren();
        validationMessage.hidden = unique.length === 0;
        if (unique.length === 0) return;

        const list = document.createElement('ul');
        unique.forEach(message => {
            const item = document.createElement('li');
            item.textContent = message;
            list.appendChild(item);
        });
        validationMessage.appendChild(list);
        if (focus) validationMessage.focus({ preventScroll: true });
    }

    function showWarningMessages(messages: readonly string[]): void {
        const unique = [...new Set(messages.filter(message => message.length > 0))];
        warningBox.replaceChildren();
        if (unique.length === 0) {
            warningBox.style.display = 'none';
            return;
        }

        warningBox.style.display = '';
        warningBox.appendChild(createIcon('fas fa-exclamation-triangle'));
        const content = document.createElement('div');
        unique.forEach(message => {
            const line = document.createElement('div');
            line.textContent = message;
            content.appendChild(line);
        });
        warningBox.appendChild(content);
    }

    function setRecoveryStatus(message = '', isError = false) {
        recoveryStatus.textContent = message;
        recoveryStatus.classList.toggle('error', isError);
        recoveryStatus.hidden = !message;
    }

    function syncRecoveryButton() {
        const count = interruptedReservations.length;
        recoverInterruptedBtn.hidden = count === 0;
        if (count > 0 && !isBusy) {
            setButtonContent(
                recoverInterruptedBtn,
                'fas fa-shield-halved',
                `中断ファイル ${count} 件を安全に片付ける`
            );
        }
    }

    function getBaseValidationErrors() {
        if (!nameInput.value.trim()) return [];

        const errors = [...nameParseErrors];
        const gradeResult = Core.validateComponent(gradeEl.value, '学年', 30);
        const classResult = Core.validateComponent(classEl.value, '学級', 30);
        const startResult = Core.validateStartNumber(startNumEl.value);
        if (!gradeResult.ok) errors.push(gradeResult.error);
        if (!classResult.ok) errors.push(classResult.error);
        if (!startResult.ok) errors.push(startResult.error);
        nameList.forEach((name, index) => {
            if (!name) return;
            const result = Core.validateComponent(name, `名前リストの${index + 1}行目`);
            if (!result.ok) errors.push(result.error);
        });
        return [...new Set(errors)];
    }

    function parseNames() {
        const parsed = Core.parseNameList(nameInput.value);
        nameList = parsed.names;
        nameParseErrors = parsed.errors;
        nameListPreview.replaceChildren();

        if (nameList.length === 0) {
            const placeholder = document.createElement('p');
            placeholder.className = 'placeholder-text';
            placeholder.textContent = '名前を入力すると一覧が表示されます';
            nameListPreview.appendChild(placeholder);
            nameCountEl.textContent = '';
            showValidationMessages([]);
            return;
        }

        const startResult = Core.validateStartNumber(startNumEl.value);
        nameList.forEach((name, index) => {
            const row = document.createElement('div');
            row.className = 'name-row';
            const number = document.createElement('span');
            number.className = 'num';
            number.textContent = startResult.ok
                ? String(startResult.value + index).padStart(2, '0')
                : '--';
            const nameText = document.createElement('span');
            nameText.textContent = name || '（空欄）';
            row.append(number, nameText);
            nameListPreview.appendChild(row);
        });
        nameCountEl.textContent = `${nameList.length} 名`;
        showValidationMessages(getBaseValidationErrors());
    }

    async function buildDirectorySnapshot(handle: FileSystemDirectoryHandle): Promise<DirectorySnapshot> {
        const photos: PhotoFile[] = [];
        const allNames: string[] = [];
        const unsupported: string[] = [];
        const tempFiles: string[] = [];
        const reservations: ReservationView[] = [];
        const invalidJournals: string[] = [];

        try {
            for await (const entry of handle.values()) {
                if (!isFileSystemFileHandle(entry)) continue;
                allNames.push(entry.name);
                if (entry.name.startsWith(Core.TEMP_PREFIX)) tempFiles.push(entry.name);
                if (entry.name.startsWith(Core.JOURNAL_PREFIX)) {
                    const journalFile = await entry.getFile();
                    const journalRecord = await Core.readReservationRecord(journalFile);
                    if (journalRecord?.journalName === entry.name) {
                        reservations.push({
                            name: entry.name,
                            handle: entry,
                            record: journalRecord,
                            kind: 'journal'
                        });
                    } else {
                        invalidJournals.push(entry.name);
                    }
                    continue;
                }

                const extension = Core.getExtension(entry.name).toLowerCase();
                if (UNSUPPORTED_PREVIEW_EXTS.has(extension)) {
                    unsupported.push(entry.name);
                    continue;
                }
                if (!Core.isImageFile(entry.name)) continue;

                const file = await entry.getFile();
                const reservationRecord = await Core.readReservationRecord(file);
                if (reservationRecord) {
                    reservations.push({
                        name: entry.name,
                        handle: entry,
                        record: reservationRecord,
                        kind: 'marker'
                    });
                    continue;
                }
                photos.push({
                    handle: entry,
                    name: entry.name,
                    url: URL.createObjectURL(file),
                    size: file.size,
                    lastModified: file.lastModified,
                    previewFailed: null
                });
            }

            let nextPreviewIndex = 0;
            const workerCount = Math.min(4, photos.length);
            const workers = Array.from({ length: workerCount }, async () => {
                while (nextPreviewIndex < photos.length) {
                    const index = nextPreviewIndex++;
                    const photo = photos[index];
                    if (photo) photo.previewFailed = !await canPreviewImage(photo.url);
                }
            });
            await Promise.all(workers);
        } catch (error) {
            revokePhotoUrls(photos);
            throw error;
        }

        photos.sort((left, right) => Core.naturalCompare(left.name, right.name));
        const journalKeys = new Set(reservations
            .filter(item => item.kind === 'journal')
            .map(item => `${item.record.batchId}:${item.record.index}`));
        const uniqueReservations = reservations.filter(item => item.kind === 'journal'
            || !journalKeys.has(`${item.record.batchId}:${item.record.index}`));
        return {
            photos,
            allNames,
            unsupported,
            tempFiles,
            reservations: uniqueReservations,
            invalidJournals
        };
    }

    function canPreviewImage(url: string): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            const probe = new Image();
            let settled = false;
            const finish = (result: boolean): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                probe.onload = null;
                probe.onerror = null;
                resolve(result);
            };
            const timeoutId = setTimeout(() => finish(false), 30000);
            probe.onload = () => finish(probe.naturalWidth > 0 && probe.naturalHeight > 0);
            probe.onerror = () => finish(false);
            probe.src = url;
        });
    }

    function commitDirectorySnapshot(handle: FileSystemDirectoryHandle, snapshot: DirectorySnapshot, options: SnapshotOptions = {}): void {
        revokePhotoUrls(photoFiles);
        dirHandle = handle;
        photoFiles = snapshot.photos;
        directoryEntryNames = snapshot.allNames;
        unsupportedFiles = snapshot.unsupported;
        leftoverTempFiles = snapshot.tempFiles;
        interruptedReservations = snapshot.reservations;
        invalidJournalFiles = snapshot.invalidJournals;
        directoryStateStale = false;
        if (options.keepRecoveryStatus !== true) setRecoveryStatus();
        if (options.clearSkips !== false) skipNameSet.clear();
        markPlanChanged();

        folderInfo.textContent = `フォルダ: ${handle.name}`;
        syncRecoveryButton();
        renderPhotoGrid();
        updatePairs();
    }

    function syncInteractionState() {
        const locked = interactionLocked();
        [gradeEl, classEl, startNumEl, nameInput].forEach(element => {
            element.disabled = locked;
        });
        selectFolderBtn.disabled = locked || typeof window.showDirectoryPicker !== 'function';
        recoverInterruptedBtn.disabled = locked
            || directoryStateStale
            || interruptedReservations.length === 0;
        $$('.pair-action-btn, .photo-thumb').forEach(element => {
            if ('disabled' in element) element.disabled = locked;
            element.setAttribute('aria-disabled', locked ? 'true' : 'false');
            if (element.classList.contains('photo-thumb')) {
                element.draggable = !locked;
                element.tabIndex = locked ? -1 : 0;
            }
        });
        if (siteWrapper) siteWrapper.inert = isConfirmOpen;
        if (classModeToggle) classModeToggle.disabled = isConfirmOpen;
        renameBtn.disabled = locked
            || batchCompleted
            || !currentPlan?.ok
            || getExecutionErrors(currentPlan).length > 0;
    }

    function setBusy(value: boolean): void {
        isBusy = value;
        syncInteractionState();
        syncRecoveryButton();
    }

    async function selectFolder() {
        if (interactionLocked()) return;
        if (typeof window.showDirectoryPicker !== 'function') {
            showValidationMessages(['このブラウザではフォルダ操作機能を利用できません。最新版のChromeまたはEdgeで開いてください。'], true);
            return;
        }

        clearResultForNewPlan();
        setBusy(true);
        setButtonContent(selectFolderBtn, 'fas fa-spinner fa-spin', 'フォルダを読み込み中...');
        let shouldRefreshMessages = true;
        try {
            const selectedHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            const snapshot = await buildDirectorySnapshot(selectedHandle);
            commitDirectorySnapshot(selectedHandle, snapshot);
        } catch (error) {
            if (errorName(error) !== 'AbortError') {
                shouldRefreshMessages = false;
                directoryStateStale = true;
                showValidationMessages([`フォルダを読み込めませんでした: ${errorMessage(error)}`], true);
            }
        } finally {
            setBusy(false);
            setButtonContent(selectFolderBtn, 'fas fa-folder-open', 'フォルダを選択');
            if (shouldRefreshMessages) updatePairs();
        }
    }

    function decoratePreviewFailure(thumb: HTMLElement | null): void {
        if (!thumb || thumb.classList.contains('preview-failed')) return;
        thumb.classList.add('preview-failed');
        const notice = document.createElement('span');
        notice.className = 'preview-failed-label';
        notice.textContent = 'プレビュー不可';
        thumb.appendChild(notice);
    }

    function markPreviewFailure(photo: PhotoFile, thumb: HTMLElement | null): void {
        if (photo.previewFailed) return;
        photo.previewFailed = true;
        markPlanChanged();
        decoratePreviewFailure(thumb);
        if (isConfirmOpen) closeConfirmModal();
        updatePairs();
    }

    function renderPhotoGrid(focusIndex: number | null = null): void {
        photoGrid.replaceChildren();
        photoFiles.forEach((photo, index) => {
            const thumb = document.createElement('div');
            thumb.className = 'photo-thumb';
            thumb.draggable = !isBusy;
            thumb.tabIndex = isBusy ? -1 : 0;
            thumb.dataset.index = String(index);
            thumb.setAttribute('role', 'button');
            thumb.setAttribute('aria-roledescription', '並べ替え可能な写真');
            thumb.setAttribute('aria-label', `${photo.name}。矢印キーで順番を移動できます。`);

            const image = document.createElement('img');
            image.alt = photo.name;
            image.loading = 'eager';
            image.addEventListener('error', () => markPreviewFailure(photo, thumb), { once: true });
            image.src = photo.url;
            const label = document.createElement('div');
            label.className = 'photo-label';
            label.textContent = photo.name;
            thumb.append(image, label);
            if (photo.previewFailed) decoratePreviewFailure(thumb);

            thumb.addEventListener('dragstart', onDragStart);
            thumb.addEventListener('dragover', onDragOver);
            thumb.addEventListener('dragenter', onDragEnter);
            thumb.addEventListener('dragleave', onDragLeave);
            thumb.addEventListener('drop', onDrop);
            thumb.addEventListener('dragend', onDragEnd);
            thumb.addEventListener('keydown', event => {
                if (isBusy) return;
                const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key)
                    ? -1
                    : ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : 0;
                if (direction === 0) return;
                event.preventDefault();
                movePhoto(index, direction, true);
            });
            photoGrid.appendChild(thumb);
        });

        photoCountEl.textContent = photoFiles.length > 0 ? `${photoFiles.length} 枚` : '';
        if (focusIndex !== null) {
            requestAnimationFrame(() => {
                const target = photoGrid.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`);
                target?.focus();
            });
        }
    }

    function onDragStart(this: HTMLElement, event: DragEvent): void {
        if (isBusy) return;
        dragIdx = Number(this.dataset.index);
        this.classList.add('dragging');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    }

    function onDragOver(this: HTMLElement, event: DragEvent): void {
        if (isBusy) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    function onDragEnter(this: HTMLElement, event: DragEvent): void {
        if (isBusy) return;
        event.preventDefault();
        this.classList.add('drag-over');
    }

    function onDragLeave(this: HTMLElement): void {
        this.classList.remove('drag-over');
    }

    function onDrop(this: HTMLElement, event: DragEvent): void {
        if (isBusy) return;
        event.preventDefault();
        this.classList.remove('drag-over');
        const dropIdx = Number(this.dataset.index);
        if (dragIdx === null || !Number.isInteger(dragIdx) || dragIdx === dropIdx) return;

        const item = photoFiles.splice(dragIdx, 1)[0];
        if (!item) return;
        photoFiles.splice(dropIdx, 0, item);
        dragIdx = null;
        clearResultForNewPlan();
        renderPhotoGrid(dropIdx);
        updatePairs();
    }

    function onDragEnd(this: HTMLElement): void {
        dragIdx = null;
        this.classList.remove('dragging');
        $$('.photo-thumb').forEach(element => element.classList.remove('drag-over'));
    }

    function proposedName(name: string, nameIndex: number, photo: PhotoFile | null): string {
        const startResult = Core.validateStartNumber(startNumEl.value);
        const number = startResult.ok
            ? String(startResult.value + nameIndex).padStart(2, '0')
            : '--';
        const extension = photo ? `.${Core.getExtension(photo.name)}` : '';
        return `${gradeEl.value.trim()}-${classEl.value.trim()}-${number}_${name}${extension}`;
    }

    function createPairThumb(photo: PhotoFile | null, altText: string): HTMLElement {
        if (!photo) {
            const empty = document.createElement('div');
            empty.className = 'pair-thumb pair-thumb-empty';
            empty.appendChild(createIcon('fas fa-image'));
            return empty;
        }
        const thumb = document.createElement('div');
        thumb.className = 'pair-thumb';
        const image = document.createElement('img');
        image.alt = altText;
        image.loading = 'eager';
        image.addEventListener('error', () => markPreviewFailure(photo, null), { once: true });
        image.src = photo.url;
        thumb.appendChild(image);
        return thumb;
    }

    function createActionButton(options: { icon: string; label: string; className?: string; text?: string; dataset?: Record<string, string | number>; onClick: (event: MouseEvent) => void }): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `pair-action-btn${options.className ? ` ${options.className}` : ''}`;
        button.title = options.label;
        button.setAttribute('aria-label', options.label);
        button.disabled = isBusy;
        button.appendChild(createIcon(options.icon));
        if (options.text) button.appendChild(document.createTextNode(` ${options.text}`));
        Object.entries(options.dataset || {}).forEach(([key, value]) => {
            button.dataset[key] = String(value);
        });
        button.addEventListener('click', options.onClick);
        return button;
    }

    function createSpacer() {
        const spacer = document.createElement('span');
        spacer.style.width = '44px';
        spacer.setAttribute('aria-hidden', 'true');
        return spacer;
    }

    function buildCurrentPlan(): Core.RenamePlan {
        return Core.buildRenamePlan({
            grade: gradeEl.value,
            classNum: classEl.value,
            startNum: startNumEl.value,
            names: nameList,
            skippedIndices: [...skipNameSet],
            photos: photoFiles,
            existingNames: directoryEntryNames
        });
    }

    function renderPairList() {
        pairList.replaceChildren();
        let photoIndex = 0;

        nameList.forEach((name, nameIndex) => {
            const skipped = skipNameSet.has(nameIndex);
            const photo = skipped ? null : photoFiles[photoIndex] || null;
            const row = document.createElement('div');
            row.className = `pair-row${skipped ? ' skipped' : ''}`;
            const info = document.createElement('div');
            info.className = 'pair-info';
            const actions = document.createElement('div');
            actions.className = 'pair-actions';

            if (skipped) {
                const thumb = document.createElement('div');
                thumb.className = 'pair-thumb pair-thumb-empty';
                const mark = document.createElement('div');
                mark.className = 'absent-mark';
                mark.appendChild(createIcon('fas fa-user-slash'));
                thumb.appendChild(mark);

                const newName = document.createElement('div');
                newName.className = 'pair-new-name skipped-name';
                newName.textContent = proposedName(name, nameIndex, null);
                const status = document.createElement('div');
                status.className = 'pair-original absent-status';
                status.textContent = '欠席';
                info.append(newName, status);
                actions.appendChild(createActionButton({
                    icon: 'fas fa-user-slash',
                    text: '欠席',
                    className: 'btn-skip active',
                    label: `${name || `${nameIndex + 1}行目`}の欠席を解除`,
                    dataset: { nameIdx: nameIndex },
                    onClick: () => toggleSkipName(nameIndex)
                }));
                row.append(thumb, info, actions);
            } else if (photo) {
                const currentPhotoIndex = photoIndex;
                const original = document.createElement('div');
                original.className = 'pair-original';
                original.textContent = photo.name;
                const arrow = document.createElement('span');
                arrow.className = 'pair-arrow';
                arrow.appendChild(createIcon('fas fa-arrow-right'));
                const newName = document.createElement('div');
                newName.className = 'pair-new-name';
                newName.textContent = proposedName(name, nameIndex, photo);
                info.append(original, arrow, newName);

                actions.appendChild(currentPhotoIndex > 0
                    ? createActionButton({
                        icon: 'fas fa-chevron-up',
                        label: `${photo.name}を上に移動`,
                        dataset: { photoIdx: currentPhotoIndex, dir: -1 },
                        onClick: () => movePhoto(currentPhotoIndex, -1)
                    })
                    : createSpacer());
                actions.appendChild(currentPhotoIndex < photoFiles.length - 1
                    ? createActionButton({
                        icon: 'fas fa-chevron-down',
                        label: `${photo.name}を下に移動`,
                        dataset: { photoIdx: currentPhotoIndex, dir: 1 },
                        onClick: () => movePhoto(currentPhotoIndex, 1)
                    })
                    : createSpacer());
                actions.appendChild(createActionButton({
                    icon: 'fas fa-user-slash',
                    className: 'btn-skip',
                    label: `${name || `${nameIndex + 1}行目`}を欠席にする`,
                    dataset: { nameIdx: nameIndex },
                    onClick: () => toggleSkipName(nameIndex)
                }));
                row.append(createPairThumb(photo, `${name}に対応する${photo.name}`), info, actions);
                photoIndex++;
            } else {
                const newName = document.createElement('div');
                newName.className = 'pair-new-name';
                newName.textContent = proposedName(name, nameIndex, null);
                const status = document.createElement('div');
                status.className = 'pair-original missing-photo-status';
                status.textContent = '写真なし';
                info.append(newName, status);
                actions.appendChild(createActionButton({
                    icon: 'fas fa-user-slash',
                    className: 'btn-skip',
                    label: `${name || `${nameIndex + 1}行目`}を欠席にする`,
                    dataset: { nameIdx: nameIndex },
                    onClick: () => toggleSkipName(nameIndex)
                }));
                row.append(createPairThumb(null, ''), info, actions);
            }
            pairList.appendChild(row);
        });

        while (photoIndex < photoFiles.length) {
            const photo = photoFiles[photoIndex];
            if (!photo) break;
            const row = document.createElement('div');
            row.className = 'pair-row unpaired-photo';
            const info = document.createElement('div');
            info.className = 'pair-info';
            const original = document.createElement('div');
            original.className = 'pair-original';
            original.textContent = photo.name;
            const status = document.createElement('div');
            status.className = 'pair-new-name unpaired-status';
            status.textContent = '対応する名前なし';
            info.append(original, status);
            const actions = document.createElement('div');
            actions.className = 'pair-actions';
            row.append(createPairThumb(photo, `対応する名前がない${photo.name}`), info, actions);
            pairList.appendChild(row);
            photoIndex++;
        }
    }

    function updatePairs() {
        const baseErrors = getBaseValidationErrors();
        const folderErrors = getFolderSafetyErrors();
        if (photoFiles.length === 0 || nameList.length === 0) {
            showValidationMessages([...baseErrors, ...folderErrors]);
            showWarningMessages([]);
            step4.style.display = 'none';
            currentPlan = null;
            renameBtn.disabled = true;
            syncInteractionState();
            return;
        }

        showValidationMessages(baseErrors);
        step4.style.display = '';
        renderPairList();
        currentPlan = buildCurrentPlan();
        const errors = getExecutionErrors(currentPlan);
        showWarningMessages(errors);
        renameBtn.disabled = interactionLocked() || batchCompleted || !currentPlan.ok || errors.length > 0;
        if (!interactionLocked() && !batchCompleted) setRenameButtonDefault();
        syncInteractionState();
    }

    function getFolderSafetyErrors(): string[] {
        const errors: string[] = [];
        if (unsupportedFiles.length > 0) {
            errors.push(`プレビューできない形式の写真があります（${unsupportedFiles.join('、')}）。JPEG・PNG・GIF・BMP・WebPへ変換してください。`);
        }
        const recoverableTempNames = new Set(interruptedReservations.map(item => item.record.tempName));
        const unknownTempFiles = leftoverTempFiles.filter(name => !recoverableTempNames.has(name));
        if (interruptedReservations.length > 0) {
            errors.push(`前回処理が途中で中断された記録が ${interruptedReservations.length} 件あります。「中断ファイルを安全に片付ける」を実行してください。原本と一時ファイルが一致する場合だけ片付けます。`);
        }
        if (unknownTempFiles.length > 0) {
            errors.push(`前回処理の確認できない一時ファイルが残っています（${unknownTempFiles.join('、')}）。原本を確認してから一時ファイルを退避または削除してください。`);
        }
        if (invalidJournalFiles.length > 0) {
            errors.push(`前回処理の壊れた復旧台帳が残っています（${invalidJournalFiles.join('、')}）。写真と一時ファイルを確認してから台帳を退避してください。`);
        }
        const failedPreviews = photoFiles.filter(photo => photo.previewFailed).map(photo => photo.name);
        if (failedPreviews.length > 0) {
            errors.push(`プレビューできない写真があります（${failedPreviews.join('、')}）。内容を確認できないため実行できません。`);
        }
        if (photoFiles.some(photo => photo.previewFailed === null)) {
            errors.push('写真のプレビュー確認が完了していません。');
        }
        if (directoryStateStale) {
            errors.push('フォルダの最新状態を確認できません。フォルダを選び直してください。');
        }
        if (dirHandle
            && photoFiles.length === 0
            && unsupportedFiles.length === 0
            && leftoverTempFiles.length === 0
            && interruptedReservations.length === 0
            && invalidJournalFiles.length === 0) {
            errors.push('対応する写真がフォルダ内に見つかりません。JPEG・PNG・GIF・BMP・WebPを用意してください。');
        }
        return [...new Set(errors)];
    }

    function getExecutionErrors(plan: Core.RenamePlan | null): string[] {
        return [...new Set([...(plan?.errors || []), ...getFolderSafetyErrors()])];
    }

    function movePhoto(photoIndex: number, direction: -1 | 1, focusGrid = false): void {
        if (interactionLocked()) return;
        const newIndex = photoIndex + direction;
        if (newIndex < 0 || newIndex >= photoFiles.length) return;
        const current = photoFiles[photoIndex];
        const next = photoFiles[newIndex];
        if (!current || !next) return;
        [photoFiles[photoIndex], photoFiles[newIndex]] = [next, current];
        markPlanChanged();
        clearResultForNewPlan();
        renderPhotoGrid(focusGrid ? newIndex : null);
        updatePairs();

        if (!focusGrid) {
            requestAnimationFrame(() => {
                const button = pairList.querySelector<HTMLElement>(`[data-photo-idx="${newIndex}"]`);
                button?.focus();
            });
        }
    }

    function toggleSkipName(nameIndex: number): void {
        if (interactionLocked()) return;
        if (skipNameSet.has(nameIndex)) skipNameSet.delete(nameIndex);
        else skipNameSet.add(nameIndex);
        markPlanChanged();
        clearResultForNewPlan();
        updatePairs();
        requestAnimationFrame(() => {
            pairList.querySelector<HTMLElement>(`[data-name-idx="${nameIndex}"]`)?.focus();
        });
    }

    function openConfirmModal(plan: Core.RenamePlan): void {
        pendingPlanItems = plan.items.map(item => ({ ...item }));
        pendingPlanRevision = planRevision;
        modalReturnFocus = document.activeElement;
        confirmMessage.replaceChildren();

        const count = document.createElement('strong');
        count.textContent = `${plan.items.length} 枚`;
        confirmMessage.append(count, document.createTextNode('の写真を安全確認後にリネームします。'));

        if (skipNameSet.size > 0) {
            const skipped = nameList.filter((_, index) => skipNameSet.has(index));
            confirmMessage.append(document.createElement('br'), document.createElement('br'));
            const skippedText = document.createTextNode(`欠席者（${skipped.length}名）: ${skipped.join('、')}`);
            confirmMessage.appendChild(skippedText);
        }

        confirmMessage.append(document.createElement('br'), document.createElement('br'));
        confirmMessage.appendChild(document.createTextNode('出力先の衝突や写真の変更を再確認してから処理します。処理が終わるまで、Finder・同期アプリ・別タブからこのフォルダを変更しないでください。OS上の更新日時などは変わる場合があります。実行しますか？'));
        confirmModal.style.display = '';
        isConfirmOpen = true;
        syncInteractionState();
        confirmCancel.focus();
    }

    function closeConfirmModal(restoreFocus = true) {
        confirmModal.style.display = 'none';
        pendingPlanItems = null;
        pendingPlanRevision = null;
        isConfirmOpen = false;
        syncInteractionState();
        if (restoreFocus && modalReturnFocus instanceof HTMLElement) modalReturnFocus.focus();
        modalReturnFocus = null;
    }

    function trapModalFocus(event: KeyboardEvent): void {
        if (confirmModal.style.display === 'none') return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeConfirmModal();
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = [confirmCancel, confirmOk].filter(button => !button.disabled);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function progressLabel(detail: Core.ProgressDetail): string {
        const labels = {
            validate: '安全確認中',
            stage: '原本を保護中',
            publish: '新しい名前で保存中',
            cleanup: '仕上げ中'
        };
        const label = labels[detail.phase] || '処理中';
        return detail.total > 0 ? `${label} ${detail.current}/${detail.total}` : label;
    }

    function renderOutcome(outcome: Core.RenameOutcome): void {
        resultList.replaceChildren();
        const clean = outcome.clean === true;
        if (resultBadge) {
            resultBadge.classList.toggle('step-badge-warning', !clean);
            resultBadge.replaceChildren(
                createIcon(clean ? 'fas fa-check' : 'fas fa-exclamation-triangle'),
                document.createTextNode(clean ? ' 完了' : ' 要確認')
            );
        }
        if (resultTitleIcon) {
            resultTitleIcon.className = clean ? 'fas fa-circle-check' : 'fas fa-triangle-exclamation';
        }

        outcome.results.forEach(result => {
            const item = document.createElement('div');
            const complete = result.status === 'success' || result.status === 'unchanged';
            item.className = `result-item ${complete ? 'success' : 'error'}`;
            const iconByStatus = {
                success: 'fas fa-circle-check',
                unchanged: 'fas fa-circle-check',
                partial: 'fas fa-exclamation-triangle',
                restored: 'fas fa-rotate-left',
                failed: 'fas fa-circle-xmark'
                , pending: 'fas fa-exclamation-triangle'
            };
            item.appendChild(createIcon(iconByStatus[result.status] || 'fas fa-exclamation-triangle'));
            const summary = result.unchanged
                ? `${result.original}（変更不要）`
                : result.status === 'success'
                    ? `${result.original} → ${result.newName}`
                    : `${result.original} / ${result.newName}（${result.message || '要確認'}）`;
            item.appendChild(document.createTextNode(` ${summary}`));
            resultList.appendChild(item);
        });
        outcome.warnings.forEach(warning => {
            const item = document.createElement('div');
            item.className = 'result-item error';
            item.append(createIcon('fas fa-exclamation-triangle'), document.createTextNode(` ${warning}`));
            resultList.appendChild(item);
        });
    }

    function renderExecutionError(error: unknown): void {
        resultList.replaceChildren();
        if (resultBadge) {
            resultBadge.classList.add('step-badge-warning');
            resultBadge.replaceChildren(createIcon('fas fa-xmark'), document.createTextNode(' 中止'));
        }
        if (resultTitleIcon) resultTitleIcon.className = 'fas fa-circle-xmark';
        const item = document.createElement('div');
        item.className = 'result-item error';
        item.append(createIcon('fas fa-circle-xmark'), document.createTextNode(` 処理を中止しました: ${errorMessage(error)}`));
        resultList.appendChild(item);
        (getRenameFailure(error)?.cleanupWarnings || []).forEach(warning => {
            const warningItem = document.createElement('div');
            warningItem.className = 'result-item error';
            warningItem.textContent = `後片付けの警告: ${warning}`;
            resultList.appendChild(warningItem);
        });
    }

    async function refreshCurrentDirectory() {
        if (!dirHandle) return;
        const snapshot = await buildDirectorySnapshot(dirHandle);
        commitDirectorySnapshot(dirHandle, snapshot, { clearSkips: false });
    }

    async function recoverInterruptedFiles() {
        if (interactionLocked()
            || directoryStateStale
            || !dirHandle
            || interruptedReservations.length === 0) return;

        clearResultForNewPlan();
        const reservations = interruptedReservations.map(item => ({
            name: item.name,
            handle: item.handle
        }));
        setRecoveryStatus();
        setBusy(true);
        setButtonContent(recoverInterruptedBtn, 'fas fa-spinner fa-spin', '安全確認中...');

        try {
            const outcome = await Core.recoverInterruptedReservations({ dirHandle, reservations });
            const snapshot = await buildDirectorySnapshot(dirHandle);
            commitDirectorySnapshot(dirHandle, snapshot, {
                clearSkips: false,
                keepRecoveryStatus: true
            });

            const recoveredCount = outcome.recovered.length;
            const message = outcome.clean
                ? `中断ファイル ${recoveredCount} 件を安全に片付けました。原本は変更していません。`
                : `${recoveredCount} 件を片付けました。${outcome.warnings.length} 件は安全を確認できないため残しています: ${outcome.warnings.join(' / ')}`;
            setRecoveryStatus(message, !outcome.clean);
        } catch (error) {
            directoryStateStale = true;
            setRecoveryStatus(
                `中断ファイルを確認できませんでした。フォルダを選び直してください: ${errorMessage(error)}`,
                true
            );
            updatePairs();
        } finally {
            setBusy(false);
            syncRecoveryButton();
        }
    }

    async function executeRename(planItems: Core.RenameItem[]): Promise<void> {
        if (isBusy || !dirHandle) return;
        setBusy(true);
        resultSection.style.display = 'none';
        setButtonContent(renameBtn, 'fas fa-spinner fa-spin', '安全確認中...');
        let outcome: Core.RenameOutcome | null = null;
        let refreshFailed = false;

        try {
            outcome = await Core.executeSafeRenameBatch({
                dirHandle,
                items: planItems,
                onProgress: detail => setButtonContent(renameBtn, 'fas fa-spinner fa-spin', progressLabel(detail))
            });
            renderOutcome(outcome);
            batchCompleted = true;
        } catch (error) {
            batchCompleted = false;
            renderExecutionError(error);
        }

        try {
            await refreshCurrentDirectory();
        } catch (refreshError) {
            refreshFailed = true;
            directoryStateStale = true;
            const warning = document.createElement('div');
            warning.className = 'result-item error';
            warning.textContent = `フォルダの再読み込みに失敗しました: ${errorMessage(refreshError)}`;
            resultList.appendChild(warning);
            if (resultBadge) {
                resultBadge.classList.add('step-badge-warning');
                resultBadge.replaceChildren(createIcon('fas fa-exclamation-triangle'), document.createTextNode(' 要確認'));
            }
            if (resultTitleIcon) resultTitleIcon.className = 'fas fa-triangle-exclamation';
            batchCompleted = outcome !== null;
        } finally {
            setBusy(false);
            updatePairs();
        }

        resultSection.style.display = '';
        resultSection.tabIndex = -1;
        resultSection.focus({ preventScroll: true });
        resultSection.scrollIntoView({ behavior: 'smooth' });

        if (outcome && batchCompleted) {
            const clean = outcome.clean === true && !refreshFailed;
            setButtonContent(
                renameBtn,
                clean ? 'fas fa-check' : 'fas fa-exclamation-triangle',
                clean ? `${outcome.results.length} 枚 完了` : `${outcome.results.length} 枚 要確認`
            );
            renameBtn.disabled = true;
        } else {
            setRenameButtonDefault();
        }
    }

    nameInput.addEventListener('input', () => {
        if (interactionLocked()) return;
        markPlanChanged();
        clearResultForNewPlan();
        skipNameSet.clear();
        parseNames();
        updatePairs();
    });
    startNumEl.addEventListener('input', () => {
        if (interactionLocked()) return;
        markPlanChanged();
        clearResultForNewPlan();
        parseNames();
        updatePairs();
    });
    gradeEl.addEventListener('input', () => {
        if (interactionLocked()) return;
        markPlanChanged();
        clearResultForNewPlan();
        updatePairs();
    });
    classEl.addEventListener('input', () => {
        if (interactionLocked()) return;
        markPlanChanged();
        clearResultForNewPlan();
        updatePairs();
    });
    selectFolderBtn.addEventListener('click', selectFolder);
    recoverInterruptedBtn.addEventListener('click', recoverInterruptedFiles);

    renameBtn.addEventListener('click', () => {
        if (interactionLocked()) return;
        updatePairs();
        if (!currentPlan?.ok || renameBtn.disabled) {
            showValidationMessages(currentPlan?.errors || ['入力内容と写真を確認してください。'], true);
            return;
        }
        openConfirmModal(currentPlan);
    });
    confirmCancel.addEventListener('click', () => closeConfirmModal());
    confirmModal.addEventListener('click', event => {
        if (event.target === event.currentTarget) closeConfirmModal();
    });
    confirmModal.addEventListener('keydown', trapModalFocus);
    confirmOk.addEventListener('click', () => {
        if (!isConfirmOpen || !pendingPlanItems) return;
        const expectedRevision = pendingPlanRevision;
        const freshPlan = buildCurrentPlan();
        const errors = getExecutionErrors(freshPlan);
        const planChanged = expectedRevision !== planRevision;
        if (planChanged || !freshPlan.ok || errors.length > 0) {
            closeConfirmModal();
            currentPlan = freshPlan;
            updatePairs();
            showValidationMessages([
                planChanged
                    ? '確認画面を開いた後に内容が変わりました。もう一度ペアを確認してください。'
                    : '入力内容と写真をもう一度確認してください。'
            ], true);
            return;
        }

        const items = freshPlan.items.map(item => ({ ...item }));
        closeConfirmModal(false);
        executeRename(items);
    });

    window.addEventListener('beforeunload', () => revokePhotoUrls(photoFiles));

    parseNames();
    setRenameButtonDefault();
    if (typeof window.showDirectoryPicker !== 'function') {
        selectFolderBtn.disabled = true;
        folderInfo.textContent = 'このブラウザではフォルダ操作機能を利用できません。最新版のChromeまたはEdgeで開いてください。';
    }
