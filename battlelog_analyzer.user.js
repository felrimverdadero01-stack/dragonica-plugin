// ==UserScript==
// @name         さぼてん対戦ログ集計ツール
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  対戦ログの各キャラクター行動を集計します
// @author       ゴニョマル
// @match        https://metropolis-c.sakura.ne.jp/*/*/battlelogs/*.html
// @updateURL    https://github.com/felrimverdadero01-stack/dragonica-plugin/raw/main/battlelog_analyzer.user.js
// @downloadURL  https://github.com/felrimverdadero01-stack/dragonica-plugin/raw/main/battlelog_analyzer.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ターンテーブルの列として表示・集計する数値ステータス項目
    // これ以外のステータス名（状態異常名など）は statusConditions 系に振り分けられる
    const trackedStatusFields = ['ATK','MATK','DEF','MDEF','SPD','HIT','MHIT','EVA','MEVA','HEAL','HATE','INTER'];

    // DOM構築完了後に実行されるよう制御
    if (document.readyState !== 'loading') {
        main();
    } else {
        document.addEventListener('DOMContentLoaded', main);
    }

    function main() {
        try {
            console.log('Script started');

            // ① DOM上の battle-status-table からキャラクター一覧を取得（最優先）
            // テーブルが存在しない場合は innerText からのテキスト解析にフォールバックする
            let stats = extractCharactersFromDOM();

            if (stats && Object.keys(stats).length > 0) {
                console.log('DOM extraction successful. Found', Object.keys(stats).length, 'characters');
            } else {
                console.log('DOM extraction failed, trying text parsing');
                const battleLog = document.body.innerText;
                // ② テキスト中の「味方チーム」「敵チーム」ブロックからキャラ名を抽出
                stats = extractCharactersFromText(battleLog);
                console.log('Text extraction found', Object.keys(stats).length, 'characters');

                if (Object.keys(stats).length === 0) {
                    console.log('Text extraction failed, trying action-based parsing');
                    // ③ action-block DOM またはログテキスト中の行動パターンからキャラを収集（最終手段）
                    stats = extractCharactersFromActions(battleLog);
                    console.log('Action-based extraction found', Object.keys(stats).length, 'characters');
                }
            }

            if (stats && Object.keys(stats).length > 0) {
                // ページ本文テキストをターン単位に分割して各種行動を集計する
                const textTurns = parseTextForActions(document.body.innerText);
                aggregateActionsToStats(textTurns, stats);
                // 最終ターン冒頭テーブルの状態異常列を優先的に取得して上書きする
                parseFinalTurnStatusConditions(stats);
                // ログ本文のステータス要約行にも、その時点の累積変化量を追記する
                annotateStatusSummaryCurrentValues(stats);
                // 右側の詳細表示で使う HP 推移と状態推移を各ターンのステータス表から収集する
                collectTurnSnapshots(stats);
            }

            displayStats(stats);
        } catch (e) {
            console.error('Error in battle log analyzer:', e);
        }
    }

    // キャラクターごとの集計データの初期構造を生成する
    // summary: 全ターンを通じた累計値
    // turns:   ターン番号をキーとしたターン別の内訳
    function createBaseCharacterStat(name, team) {
        return {
            name: name,
            team: team,
            turns: {},
            summary: {
                damageDealt: {},
                hpHealed: {},
                spHealed: {},
                statusChangesReceived: {},
                statusChangesReceivedSelf: {},
                statusChangesReceivedOther: {},
                statusConditionsReceived: {},
                statusConditionsReceivedSelf: {},
                statusConditionsReceivedOther: {},
                statusConditionsFinal: {},
                maxHPIncreases: 0
            }
        };
    }

    // battle-status-table から全キャラクターを取得する
    // セル[1]=名前、セル[2]=HP(現在/最大) でキャラを識別し ally/enemy を判定する
    function extractCharactersFromDOM() {
        const stats = {};
        const tables = document.querySelectorAll('table.battle-status-table');
        console.log('extractCharactersFromDOM: tables found', tables.length);

        if (tables.length === 0) {
            console.warn('No battle-status-table tables found in DOM');
            return stats;
        }

        tables.forEach(table => {
            const className = table.className || '';
            const team = className.includes('ally-table') ? 'ally' : className.includes('enemy-table') ? 'enemy' : null;
            if (!team) {
                return;
            }

            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length < 3) {
                    return;
                }

                const charName = cells[1].textContent.trim();
                const hpText = cells[2].textContent.trim();
                const spText = cells[3] ? cells[3].textContent.trim() : '';

                const hpMatch = hpText.match(/(\d+)\s*\/\s*(\d+)/);
                if (!hpMatch || !charName || charName === '名前') {
                    return;
                }

                const hp = parseInt(hpMatch[1]);
                const mhp = parseInt(hpMatch[2]);
                if (mhp <= 0) {
                    return;
                }

                const fullName = `${team}:${charName}`;
                if (!stats[fullName]) {
                    stats[fullName] = createBaseCharacterStat(charName, team);
                    console.log('Found character from DOM:', charName, `- Team: ${team}`);
                }
            });
        });

        console.log('extractCharactersFromDOM: characters found', Object.keys(stats).length);
        return stats;
    }

    // ページテキスト中の「味方チーム」「敵チーム」セクション見出しを手がかりに
    // 「キャラ名 HP/MaxHP SP」形式の行からキャラクター一覧を構築する
    function extractCharactersFromText(text) {
        const stats = {};
        const teamRegex = /(?:味方チーム|敵チーム)[^\n]*([\s\S]*?)(?=(?:味方チーム|敵チーム|$))/g;
        let teamMatch;
        let currentTeam = null;

        while ((teamMatch = teamRegex.exec(text)) !== null) {
            const header = teamMatch[0];
            currentTeam = header.includes('味方チーム') ? 'ally' : header.includes('敵チーム') ? 'enemy' : currentTeam;
            const section = teamMatch[1];
            const lines = section.split('\n');

            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const charMatch = trimmed.match(/^([\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\-・_ａ-ｚA-Za-z0-9]+)\s+(\d+)\s*\/\s*(\d+)\s+(\d+)/);
                if (charMatch && currentTeam) {
                    const charName = charMatch[1].trim();
                    if (charName === '名前') return;
                    const fullName = `${currentTeam}:${charName}`;
                    if (!stats[fullName]) {
                        stats[fullName] = createBaseCharacterStat(charName, currentTeam);
                        console.log('Found character from text:', charName, `- Team: ${currentTeam}`);
                    }
                }
            });
        }

        return stats;
    }

    // action-block DOM が存在すればそこからキャラを収集し、
    // 存在しない場合は行動ログテキスト中の「〇〇の」パターンからキャラ名を推定する
    function extractCharactersFromActions(text) {
        const stats = {};
        const actionBlocks = document.querySelectorAll('div.action-block');

        if (actionBlocks.length > 0) {
            actionBlocks.forEach(block => {
                const firstLine = block.querySelector('p');
                if (!firstLine) return;
                const name = determineBlockSource(firstLine);
                if (!name) return;

                const team = block.className.includes('leftTeam_action') ? 'ally' : block.className.includes('rightTeam_action') ? 'enemy' : 'ally';
                const fullName = `${team}:${name}`;
                if (!stats[fullName]) {
                    stats[fullName] = createBaseCharacterStat(name, team);
                    console.log('Found character from action-blocks:', name, `- Team: ${team}`);
                }
            });
            return stats;
        }

        const actorRegex = /「(.+?)」が|^([\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\-・_ａ-ｚA-Za-z0-9]+)の/gm;
        let match;

        while ((match = actorRegex.exec(text)) !== null) {
            const charName = (match[1] || match[2] || '').trim();
            if (!charName || charName === '名前') continue;
            const fullName = `ally:${charName}`;
            if (!stats[fullName]) {
                stats[fullName] = createBaseCharacterStat(charName, 'ally');
                console.log('Found character from actions:', charName);
            }
        }

        return stats;
    }

    // DOM上の battle-turn を走査してターン構造を組み立てる
    // 各ターンでは action-block の「直下」ブロックだけを抽出し、
    // ネストされた action-block は parseActionBlock の再帰で処理する
    function parseDOMTurns() {
        const turns = [];
        const battleTurns = Array.from(document.querySelectorAll('div.battle-turn'));

        battleTurns.forEach((turnNode, index) => {
            const heading = turnNode.querySelector('h3');
            const text = heading ? heading.textContent.trim() : '';
            const match = text.match(/ターン\s*(\d+)/);
            const turnNum = match ? parseInt(match[1], 10) : index + 1;

            const allBlocks = Array.from(turnNode.querySelectorAll('div.action-block'));
            const topLevelBlocks = allBlocks.filter(block => !block.parentElement || !block.parentElement.closest('div.action-block'));

            turns.push({
                turnNum,
                actionBlocks: topLevelBlocks
            });
        });

        return turns;
    }

    // ページ本文テキストを「ターンN」という見出しで区切り、
    // 各ターンの番号と内容テキストを配列として返す
    function parseTextForActions(text) {
        const turns = [];
        const turnRegex = /ターン\s*(\d+)([\s\S]*?)(?=ターン\s*\d+|$)/g;
        let match;

        while ((match = turnRegex.exec(text)) !== null) {
            const turnNum = parseInt(match[1], 10);
            turns.push({
                turnNum: turnNum,
                content: match[2]
            });
        }

        return turns;
    }

    function aggregateDOMTurnActions(turns, stats) {
        turns.forEach(turn => {
            turn.actionBlocks.forEach(block => {
                const blockLines = Array.from(block.querySelectorAll('p'))
                    .map(paragraph => paragraph.textContent.trim())
                    .filter(Boolean)
                    .join('\n');
                if (blockLines) {
                    parseActionsFromText(blockLines, stats, turn.turnNum);
                }
            });
        });
    }

    // parseTextForActions で分割した各ターンを行単位で解析して stats に集計する
    function aggregateActionsToStats(turnData, stats) {
        const domTurns = parseDOMTurns();
        if (domTurns.length > 0 && domTurns.some(turn => turn.actionBlocks.length > 0)) {
            aggregateDOMTurnActions(domTurns, stats);
            turnData.forEach(turn => {
                if (turn.turnNum <= 1) {
                    return;
                }
                parseActionsFromText(turn.content, stats, turn.turnNum, { statusOnly: true });
            });
            return;
        }

        turnData.forEach(turn => {
            parseActionsFromText(turn.content, stats, turn.turnNum);
        });
    }

    // action-block をDOM階層どおり再帰解析する
    // 子 action-block に入っても親発動者の文脈が壊れないようにする
    function parseActionBlock(block, stats, turnNum) {
        const directParagraphs = Array.from(block.children).filter(node => node.tagName === 'P');
        if (directParagraphs.length === 0) {
            return;
        }

        const source = determineBlockSource(directParagraphs[0]);
        const sourceKey = findStatsKey(stats, source, block);
        if (!sourceKey) {
            return;
        }

        const actorName = stats[sourceKey].name;
        const children = Array.from(block.children);

        for (let index = 0; index < children.length; index++) {
            const child = children[index];
            if (!child) {
                continue;
            }

            if (child.classList && child.classList.contains('action-block')) {
                parseActionBlock(child, stats, turnNum);
                continue;
            }

            if (child.tagName !== 'P') {
                continue;
            }

            const lineText = child.textContent.trim();
            if (!lineText) continue;

            const spRecovery = parseSPRecoveryLine(lineText);
            if (spRecovery) {
                aggregateSPHealing(stats, spRecovery.source || actorName, spRecovery.target, spRecovery.recovery, turnNum);
                recordActionLog(stats, spRecovery.source || actorName, turnNum, 'sp_heal', spRecovery.target, spRecovery.recovery, `${spRecovery.target} の SP を ${spRecovery.recovery} 回復`);
                continue;
            }

            const inlineStatusChange = parseInlineStatusChangeLine(lineText, actorName, actorName);
            if (inlineStatusChange) {
                inlineStatusChange.entries.forEach(entry => {
                    recordReceivedStatusChange(stats, inlineStatusChange.target, entry.name, entry.value, turnNum, inlineStatusChange.source);
                });
                recordActionLog(stats, inlineStatusChange.source || actorName, turnNum, 'status', inlineStatusChange.target, inlineStatusChange.entries.length, inlineStatusChange.entries.map(entry => `${entry.name} ${entry.value}`).join(', '));
                continue;
            }

            const damageInfo = parseDamageLine(lineText);
            if (damageInfo) {
                aggregateDamage(stats, actorName, damageInfo.target, damageInfo.damage, turnNum);
                recordActionLog(stats, actorName, turnNum, 'damage', damageInfo.target, damageInfo.damage, `${damageInfo.target} に ${damageInfo.damage} ダメージ`);
                continue;
            }

            const hpRecovery = parseHPRecoveryLine(lineText);
            if (hpRecovery) {
                aggregateHPHealing(stats, actorName, hpRecovery.target, hpRecovery.recovery, turnNum);
                recordActionLog(stats, actorName, turnNum, 'heal', hpRecovery.target, hpRecovery.recovery, `${hpRecovery.target} に ${hpRecovery.recovery} 回復`);
                continue;
            }

            const hpIncMatch = lineText.match(/^(.+?) の最大HPが\s*\+\s*([0-9,]+)\s*増加した/);
            if (hpIncMatch) {
                const target = hpIncMatch[1].trim();
                const increase = parseInt(hpIncMatch[2].replace(/,/g, ''), 10);
                recordMaxHPIncrease(stats, target, increase, turnNum);
                recordActionLog(stats, actorName, turnNum, 'max_hp', target, increase, `${target} の最大HP +${increase}`);
                continue;
            }

            const statusMatch = lineText.match(/^(.+?)\s*(?:の|に)\s.*?(ステータスが上昇|ステータスが低下|ステータスが変化|状態異常が付与された).*$/);
            if (statusMatch) {
                const target = statusMatch[1].trim();
                const summaryInfo = getNextStatusSummaryParagraph(children, index + 1);
                const summaryLine = summaryInfo ? summaryInfo.text : '';
                const changeType = lineText.includes('上昇') ? 1 : lineText.includes('低下') ? -1 : 0;
                const parsedStatus = parseStatusSummary(summaryLine, changeType);
                parsedStatus.forEach(entry => {
                    recordReceivedStatusChange(stats, target, entry.name, entry.value, turnNum, actorName);
                });
                if (parsedStatus.length > 0) {
                    recordActionLog(stats, actorName, turnNum, 'status', target, parsedStatus.length, parsedStatus.map(entry => `${entry.name} ${entry.value}`).join(', '));
                }
                if (summaryInfo && parsedStatus.length > 0) {
                    index = summaryInfo.index;
                }
                continue;
            }
        }
    }

    function getNextStatusSummaryParagraph(children, startIndex) {
        for (let index = startIndex; index < children.length; index++) {
            const child = children[index];
            if (!child || child.tagName !== 'P') {
                continue;
            }

            const text = child.textContent.trim();
            if (!text) {
                continue;
            }

            if (!child.classList.contains('status-summary')) {
                continue;
            }

            return { index, text };
        }

        return null;
    }

    function determineBlockSource(firstLine) {
        const strong = firstLine.querySelector('strong');
        if (strong && strong.textContent.trim()) {
            return strong.textContent.trim();
        }
        const text = firstLine.textContent.trim();
        const match = text.match(/^(.+?) の /);
        return match ? match[1].trim() : null;
    }

    function findStatsKey(stats, name, block) {
        if (!name) {
            return null;
        }

        const team = block.className.includes('leftTeam_action') ? 'ally' : block.className.includes('rightTeam_action') ? 'enemy' : null;
        const candidates = Object.keys(stats).filter(key => stats[key].name === name);
        if (candidates.length === 1) {
            return candidates[0];
        }
        if (team) {
            const exact = candidates.find(key => stats[key].team === team);
            if (exact) {
                return exact;
            }
        }

        return candidates[0] || null;
    }

    // 「ATK +5 MATK +3」のようなステータス変化の要約行を解析して
    // { name, value } のエントリ配列を返す
    // ※ 「ATK +10%」のような % 付きは一時的な倍率変化とみなし除外する
    // 数値付き形式で解析できなかった場合はトークン単位でフォールバック解析する
    function parseStatusSummary(summaryText, changeType) {
        const entries = [];
        if (!summaryText) {
            return entries;
        }

        // 一時バフ/デバフの % 表記は集計対象外にする
        const filteredSummaryText = summaryText.replace(/[A-Za-z0-9()]+\s*[+-][0-9,]+%/g, '').trim();
        if (!filteredSummaryText) {
            return entries;
        }

        // 「フィールド名 ±数値」の形式を優先的に抽出する
        const numericRegex = /([A-Za-z0-9()]+)\s*([+-][0-9,]+)/g;
        let match;
        while ((match = numericRegex.exec(filteredSummaryText)) !== null) {
            entries.push({
                name: match[1].trim(),
                value: parseInt(match[2].replace(/,/g, ''), 10)
            });
        }

        if (entries.length > 0) {
            return entries;
        }

        // 数値なしトークン（状態異常名など）のフォールバック解析
        const tokenRegex = /([^\s]+(?:\([^\)]*\))?)/g;
        while ((match = tokenRegex.exec(filteredSummaryText)) !== null) {
            const token = match[1].trim();
            if (token && !token.includes('%')) {
                const levelMatch = token.match(/^(.+?)(\d+)(?:\(.*\))?$/u);
                if (levelMatch) {
                    entries.push({name: levelMatch[1].trim(), value: parseInt(levelMatch[2], 10)});
                } else {
                    const parenMatch = token.match(/^(.+?)\((?:レベル:)?(\d+)\)$/u);
                    if (parenMatch) {
                        entries.push({name: parenMatch[1].trim(), value: parseInt(parenMatch[2], 10)});
                    } else {
                        entries.push({name: token, value: changeType !== 0 ? changeType : 1});
                    }
                }
            }
        }

        return entries;
    }

    // 「〇〇 に NNN ダメージを与えた」形式の行を解析する
    // 発動者は呼び出し元の currentChar で管理するため、ここでは対象と数値のみ返す
    function parseDamageLine(lineText) {
        if (!lineText || !lineText.includes('ダメージを与えた')) {
            return null;
        }

        const match = lineText.match(/(.+?)\s*に\s*([0-9,]+)\s*ダメージを与えた/);
        if (!match) {
            return null;
        }

        return {
            target: match[1].trim(),
            damage: parseInt(match[2].replace(/,/g, ''), 10)
        };
    }

    // 「〇〇 を NNN 回復した」形式の HP 回復行を解析する
    // SP を含む行（SP 回復ログ）は parseSPRecoveryLine で処理するため除外する
    function parseHPRecoveryLine(lineText) {
        if (!lineText || !lineText.includes('回復した') || lineText.includes('SP')) {
            return null;
        }

        const match = lineText.match(/(?:.+?の「.+?」が\s*)?(.+?)\s*を\s*([0-9,]+)\s*回復した/);
        if (!match) {
            return null;
        }

        return {
            target: match[1].trim(),
            recovery: parseInt(match[2].replace(/,/g, ''), 10)
        };
    }

    // 「ATK と MATK が 30 増加した」「〇〇 の ATK が 5 低下した」のような
    // インライン形式のステータス変化行を解析する
    // 対象が省略されている場合は defaultTarget（currentChar）を使用する
    function parseInlineStatusChangeLine(lineText, defaultTarget, source) {
        if (!lineText || (!lineText.includes('増加') && !lineText.includes('低下'))) {
            return null;
        }

        if (lineText.includes('%')) {
            return null;
        }

        const fieldPattern = trackedStatusFields.join('|');
        const match = lineText.match(new RegExp(`^(?:(.+?)\\s+(?:は|の)\\s+)?((?:${fieldPattern})(?:\\s*と\\s*(?:${fieldPattern}))*)\\s+が\\s*([+-]?[0-9,]+)\\s*(増加|低下)(?:した)?[！!。．]?$`));
        if (!match) {
            return null;
        }

        const target = (match[1] ? match[1].trim() : defaultTarget) || defaultTarget;
        const fieldsText = match[2].trim();
        const magnitude = parseInt(match[3].replace(/,/g, ''), 10);
        const sign = match[4] === '低下' ? -1 : 1;
        const fields = fieldsText.split(/\s*と\s*/).map(field => field.trim()).filter(field => trackedStatusFields.includes(field));

        if (!target || fields.length === 0) {
            return null;
        }

        return {
            target,
            source: source || defaultTarget || target,
            entries: fields.map(field => ({name: field, value: sign * magnitude}))
        };
    }

    // SP 回復ログを複数のログ出力形式に対応して解析する
    // patterns[0]: 「〇〇 の「スキル名」が 〇〇 の SP を NNN 回復した」（アイテム/他者回復型）
    // patterns[1]: 「〇〇 の スキル名! 〇〇 の SP が NNN 回復した」（ユートピア型）
    // patterns[2]: 「〇〇 の SP が NNN 回復した」（自己回復型）
    // patterns[3]: 「〇〇 は 〇〇 により NNN SP回復 した」（状態/効果型）
    function parseSPRecoveryLine(lineText) {
        if (!lineText || !lineText.includes('回復')) {
            return null;
        }

        const patterns = [
            /^(.*?)\s*の「.+?」が\s*(.+?)\s*の\s*SPを\s*([0-9,]+)\s*回復した/,
            /^(.*?)\s*の\s*.+?!\s*(.+?)\s*の\s*SPが\s*([0-9,]+)\s*回復した/,
            /^(.+?)\s*の\s*SPが\s*([0-9,]+)\s*回復した/,
            /^(.+?)\s*は\s*.+?により\s*([0-9,]+)\s*SP回復\s*した/
        ];

        const etherMatch = lineText.match(patterns[0]);
        if (etherMatch) {
            return {
                source: etherMatch[1].trim(),
                target: etherMatch[2].trim(),
                recovery: parseInt(etherMatch[3].replace(/,/g, ''), 10)
            };
        }

        const utopiaMatch = lineText.match(patterns[1]);
        if (utopiaMatch) {
            return {
                source: utopiaMatch[1].trim(),
                target: utopiaMatch[2].trim(),
                recovery: parseInt(utopiaMatch[3].replace(/,/g, ''), 10)
            };
        }

        const selfMatch = lineText.match(patterns[2]);
        if (selfMatch) {
            return {
                source: selfMatch[1].trim(),
                target: selfMatch[1].trim(),
                recovery: parseInt(selfMatch[2].replace(/,/g, ''), 10)
            };
        }

        const conditionMatch = lineText.match(patterns[3]);
        if (conditionMatch) {
            return {
                source: conditionMatch[1].trim(),
                target: conditionMatch[1].trim(),
                recovery: parseInt(conditionMatch[2].replace(/,/g, ''), 10)
            };
        }

        return null;
    }

    // 最終ターン冒頭の battle-status-table の最終列（状態異常列）を読み取り、
    // statusConditionsFinal に格納する
    // ログ途中で付与された状態異常より最終状態を優先表示するため、別途上書きする
    function parseFinalTurnStatusConditions(stats) {
        const battleTurns = document.querySelectorAll('div.battle-turn');
        if (battleTurns.length === 0) {
            return;
        }

        const lastTurn = battleTurns[battleTurns.length - 1];
        if (!lastTurn) {
            return;
        }

        const tables = lastTurn.querySelectorAll('table.battle-status-table');
        tables.forEach(table => {
            const team = table.className.includes('ally-table') ? 'ally' : table.className.includes('enemy-table') ? 'enemy' : null;
            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length < 2) {
                    return;
                }

                const charName = cells[1].textContent.trim();
                if (!charName || charName === '名前') {
                    return;
                }

                const conditionCell = cells[cells.length - 1];
                const conditionText = conditionCell ? conditionCell.textContent.trim() : '';
                const conditionMap = parseConditionText(conditionText);
                if (Object.keys(conditionMap).length === 0) {
                    return;
                }

                Object.keys(stats).forEach(key => {
                    if (stats[key].name === charName) {
                        stats[key].summary.statusConditionsFinal = conditionMap;
                    }
                });
            });
        });
    }

    // 「毒2 スタン 呪い3」のような状態異常テキストをパースして
    // { 状態名: レベル } のマップを返す。レベル表記がない場合は 1 とする。
    function parseConditionText(text) {
        const map = {};
        if (!text) {
            return map;
        }

        const tokens = text.split(/\s+/).filter(Boolean);
        tokens.forEach(token => {
            const normalized = token.trim();
            if (!normalized) return;
            const match = normalized.match(/^(.+?)(\d+)?(?:\(.*\))?$/u);
            if (match) {
                const name = match[1].trim();
                const value = match[2] ? parseInt(match[2], 10) : 1;
                if (name) {
                    map[name] = value;
                }
            }
        });
        return map;
    }

    // 表示中の status-summary 行を DOM 順に走査し、同ターゲットに対する累積値を追記する
    // テキスト主経路がターン前の受動発動を拾わないため、表示更新は DOM ベースで独立して計算する
    function annotateStatusSummaryCurrentValues(stats) {
        const currentStatusTotals = {};
        const paragraphs = Array.from(document.querySelectorAll('div.action-block p, p.status-summary'));
        paragraphs.forEach(paragraph => annotateStatusSummaryParagraph(paragraph, currentStatusTotals, stats));
    }

    function annotateStatusSummaryInActionBlock(block, currentStatusTotals, stats) {
        const children = Array.from(block.children);

        for (let index = 0; index < children.length; index++) {
            const child = children[index];
            if (!child) {
                continue;
            }

            if (child.classList && child.classList.contains('action-block')) {
                annotateStatusSummaryInActionBlock(child, currentStatusTotals, stats);
                continue;
            }

            if (child.tagName !== 'P') {
                continue;
            }

            annotateStatusSummaryParagraph(child, currentStatusTotals, stats);
        }
    }

    function annotateStatusSummaryParagraph(node, currentStatusTotals, stats) {
        if (!node || node.tagName !== 'P') {
            return;
        }

        const lineText = node.textContent.trim();
        if (!lineText) {
            return;
        }

        const block = node.closest('div.action-block');
        const source = block ? determineBlockSource(Array.from(block.children).find(child => child.tagName === 'P')) || getActionBlockSourceName(node) : null;
        const inlineStatusChange = parseInlineStatusChangeLine(lineText, source, source);
        if (inlineStatusChange) {
            applyRunningTrackedStatus(currentStatusTotals, inlineStatusChange.target, inlineStatusChange.entries);
            recordTurnCurrentStatusSnapshot(stats, node, inlineStatusChange.target, currentStatusTotals, inlineStatusChange.entries);
            const currentValueText = formatCurrentStatusValueText(currentStatusTotals[inlineStatusChange.target], inlineStatusChange.entries);
            if (!currentValueText) {
                return;
            }

            const originalText = node.dataset.originalStatusSummary || lineText;
            node.dataset.originalStatusSummary = originalText;
            node.textContent = `${originalText} （現在値：${currentValueText}）`;
            return;
        }

        const headerNode = findStatusSummaryHeader(node);
        if (!headerNode) {
            return;
        }

        const headerText = headerNode.textContent.trim();
        if (!isStatusChangeHeaderLine(headerText)) {
            return;
        }

        const target = extractStatusTargetFromHeader(headerText, source);
        if (!target) {
            return;
        }

        const changeType = headerText.includes('上昇') ? 1 : headerText.includes('低下') ? -1 : 0;
        const parsedStatus = parseStatusSummary(lineText, changeType)
            .filter(entry => trackedStatusFields.includes(entry.name));
        if (parsedStatus.length === 0) {
            return;
        }

        applyRunningTrackedStatus(currentStatusTotals, target, parsedStatus);
        recordTurnCurrentStatusSnapshot(stats, node, target, currentStatusTotals, parsedStatus);
        const currentValueText = formatCurrentStatusValueText(currentStatusTotals[target], parsedStatus);
        if (!currentValueText) {
            return;
        }

        const originalText = node.dataset.originalStatusSummary || lineText;
        node.dataset.originalStatusSummary = originalText;
        node.textContent = `${originalText} （現在値：${currentValueText}）`;
    }

    // 注釈で確定した「その時点の現在値」をターン別に保持し、統計表示側と同じ値源にそろえる
    function recordTurnCurrentStatusSnapshot(stats, node, targetName, currentStatusTotals, entries) {
        if (!stats || !node || !targetName || !currentStatusTotals[targetName]) {
            return;
        }

        const turnNode = node.closest('div.battle-turn');
        const heading = turnNode ? turnNode.querySelector('h3') : null;
        const turnMatch = heading ? heading.textContent.trim().match(/ターン\s*(\d+)/) : null;
        const turnNum = turnMatch ? Number(turnMatch[1]) : null;
        if (!turnNum) {
            return;
        }

        const candidates = Object.keys(stats).filter(key => stats[key].name === targetName);
        if (candidates.length === 0) {
            return;
        }

        const targetKey = candidates[0];
        if (!stats[targetKey].turns[turnNum]) {
            stats[targetKey].turns[turnNum] = {};
        }
        if (!stats[targetKey].turns[turnNum].statusCurrent) {
            stats[targetKey].turns[turnNum].statusCurrent = {};
        }

        entries.forEach(entry => {
            if (!trackedStatusFields.includes(entry.name)) {
                return;
            }
            stats[targetKey].turns[turnNum].statusCurrent[entry.name] = currentStatusTotals[targetName][entry.name] || 0;
        });
    }

    function getActionBlockSourceName(node) {
        const block = node.closest('div.action-block');
        if (!block) {
            return null;
        }

        const firstParagraph = Array.from(block.children).find(child => child.tagName === 'P');
        return firstParagraph ? determineBlockSource(firstParagraph) : null;
    }

    function findStatusSummaryHeader(summaryNode) {
        let previous = summaryNode.previousElementSibling;

        while (previous) {
            if (previous.tagName === 'P') {
                const text = previous.textContent.trim();
                if (text) {
                    return previous;
                }
            }
            previous = previous.previousElementSibling;
        }

        return null;
    }

    function isStatusChangeHeaderLine(lineText) {
        return lineText.includes('ステータスが上昇') || lineText.includes('ステータスが低下') || lineText.includes('ステータスが変化');
    }

    function extractStatusTargetFromHeader(lineText, fallbackTarget) {
        const match = lineText.match(/^(.+?)\s*(?:の|に)\s.*?(ステータスが上昇|ステータスが低下|ステータスが変化)/);
        return match ? match[1].trim() : fallbackTarget || null;
    }

    function applyRunningTrackedStatus(currentStatusTotals, target, entries) {
        if (!target) {
            return;
        }

        if (!currentStatusTotals[target]) {
            currentStatusTotals[target] = {};
        }

        entries.forEach(entry => {
            if (!trackedStatusFields.includes(entry.name)) {
                return;
            }
            currentStatusTotals[target][entry.name] = (currentStatusTotals[target][entry.name] || 0) + entry.value;
        });
    }

    function formatMap(map, signed = false) {
        if (!map || Object.keys(map).length === 0) {
            return '-';
        }
        return Object.entries(map).map(([key, value]) => `${key}:${signed ? formatSigned(value) : value}`).join('<br>');
    }

    function formatSigned(value) {
        return value >= 0 ? `+${value}` : `${value}`;
    }

    function formatStatusSummary(map) {
        if (!map) {
            return '-';
        }
        return trackedStatusFields.map(key => {
            const value = map[key] || 0;
            return `${key}: ${formatSigned(value)}`;
        }).join('<br>');
    }

    function formatConditionMap(map) {
        if (!map || Object.keys(map).length === 0) {
            return '-';
        }
        return Object.entries(map).map(([key, value]) => {
            return value > 1 ? `${key}: ${value}` : `${key}`;
        }).join('<br>');
    }

    function getTurnStatusValue(turnData, field) {
        const self = (turnData.statusChangesSelf && turnData.statusChangesSelf[field]) || 0;
        const other = (turnData.statusChangesOther && turnData.statusChangesOther[field]) || 0;
        const total = self + other;
        return total !== 0 ? formatSigned(total) : '-';
    }

    function mergeConditionMaps(turnData) {
        const merged = {};
        ['statusConditions', 'statusConditionsSelf', 'statusConditionsOther'].forEach(key => {
            const map = turnData[key];
            if (map) {
                Object.entries(map).forEach(([condition, value]) => {
                    const numericValue = Number(value) || 0;
                    if (numericValue !== 0) {
                        merged[condition] = (merged[condition] || 0) + numericValue;
                    }
                });
            }
        });
        return merged;
    }

    function buildRunningStatusFieldMatrix(stat, turnNumbers) {
        const runningTotals = {};
        return trackedStatusFields.map(field => ({
            field,
            row: turnNumbers.map(turn => {
                const turnData = stat.turns[turn] || {};
                const currentSnapshot = turnData.statusCurrent || null;
                if (currentSnapshot && currentSnapshot[field] !== undefined) {
                    runningTotals[field] = currentSnapshot[field];
                } else {
                    const selfValue = (turnData.statusChangesSelf && turnData.statusChangesSelf[field]) || 0;
                    const otherValue = (turnData.statusChangesOther && turnData.statusChangesOther[field]) || 0;
                    runningTotals[field] = (runningTotals[field] || 0) + selfValue + otherValue;
                }
                return runningTotals[field];
            })
        }));
    }

    function buildConditionTrendMatrix(stat, turnNumbers) {
        const conditionSet = new Set();
        turnNumbers.forEach(turn => {
            const turnData = stat.turns[turn] || {};
            const currentTurnMap = turnData.statusConditions && Object.keys(turnData.statusConditions).length > 0
                ? turnData.statusConditions
                : mergeConditionMaps(turnData);
            Object.keys(currentTurnMap).forEach(condition => conditionSet.add(condition));
        });

        return Array.from(conditionSet).sort().map(condition => ({
            condition,
            values: turnNumbers.map(turn => {
                const turnData = stat.turns[turn] || {};
                const currentTurnMap = turnData.statusConditions && Object.keys(turnData.statusConditions).length > 0
                    ? turnData.statusConditions
                    : mergeConditionMaps(turnData);
                return currentTurnMap[condition] || 0;
            })
        }));
    }

    function formatStatusMap(map) {
        if (!map || Object.keys(map).length === 0) {
            return '-';
        }
        const entries = trackedStatusFields
            .filter(key => map[key] !== undefined && map[key] !== 0)
            .map(key => `${key}:${formatSigned(map[key])}`);
        if (entries.length > 0) {
            return entries.join('<br>');
        }
        return Object.entries(map).map(([key, value]) => `${key}:${formatSigned(value)}`).join('<br>');
    }

    function formatStatusChangesCell(turnData) {
        const selfHtml = formatMap(turnData.statusChangesSelf, true);
        const otherHtml = formatMap(turnData.statusChangesOther, true);
        const lines = [];
        if (selfHtml !== '-') {
            lines.push(`<strong>自己:</strong> ${selfHtml}`);
        }
        if (otherHtml !== '-') {
            lines.push(`<strong>他者:</strong> ${otherHtml}`);
        }
        return lines.length > 0 ? lines.join('<br>') : '-';
    }

    function formatCurrentStatusValueText(currentTotals, entries) {
        if (!currentTotals) {
            return '';
        }

        const fields = Array.from(new Set(entries.map(entry => entry.name)));
        return fields.map(field => `${field}${formatSigned(currentTotals[field] || 0)}`).join(' ');
    }

    // テキスト行から行動の発動者名を特定する
    // ステータス変化結果行・ダメージ結果行など「結果を受けた」側の行は
    // 誤って発動者と判定しないよう除外する
    // 例: 「キャロット・ラペ の ステータスが低下！」はターゲット行であり発動者行ではない
    function extractActorFromLine(line, charNames) {
        if (!line) {
            return null;
        }

        // 結果行は発動者切り替えに使わない
        if (
            line.includes('ステータスが上昇') ||
            line.includes('ステータスが低下') ||
            line.includes('ステータスが変化') ||
            line.includes('状態異常が付与') ||
            line.includes('ダメージを与えた') ||
            line.includes('回復した') ||
            line.includes('最大HPが') ||
            line.includes('を受けた')
        ) {
            return null;
        }

        for (const name of charNames) {
            if (line.startsWith(`${name} の`)) {
                return name;
            }
        }

        const charMatch = line.match(/^(.+?)\s*の\s+/);
        if (!charMatch) {
            return null;
        }

        const candidate = charMatch[1].trim();
        return charNames.includes(candidate) ? candidate : null;
    }

    // startIndex 以降で最初の非空行を探し { index, value } を返す
    // ステータス変化ヘッダー行と要約行の間に空行が挟まる場合があるため
    // lines[index + 1] の直接参照ではなくこの関数を使う
    function getNextNonEmptyLine(lines, startIndex) {
        for (let index = startIndex; index < lines.length; index++) {
            const value = lines[index].trim();
            if (value) {
                return { index, value };
            }
        }

        return null;
    }

    // テキスト形式のターン内容を 1 行ずつ走査して全集計を行うメインパーサー
    // currentChar に「現在の行動発動者」を保持しながら各結果行を解析する
    // charNames は長い名前を先に照合するよう降順ソートして部分一致誤検知を防ぐ
    function parseActionsFromText(turnContent, stats, turnNum, options = {}) {
        const lines = turnContent.split('\n');
        let currentChar = null;
        const charNames = Object.values(stats).map(s => s.name).sort((a, b) => b.length - a.length);
        const statusOnly = options.statusOnly === true;

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].trim();
            if (!line) continue;

            // 発動者の切り替えは行動宣言行だけに限定する
            // ステータス結果行やダメージ結果行では currentChar を変えない
            const actorFromLine = extractActorFromLine(line, charNames);
            if (actorFromLine) {
                currentChar = actorFromLine;
            }

            if (!currentChar) continue;

            // --- 各行の種別を優先順に判定して集計 ---

            if (statusOnly) {
                const inlineStatusChange = parseInlineStatusChangeLine(line, currentChar, currentChar);
                if (inlineStatusChange) {
                    inlineStatusChange.entries.forEach(entry => {
                        recordReceivedStatusChange(stats, inlineStatusChange.target, entry.name, entry.value, turnNum, inlineStatusChange.source);
                    });
                    continue;
                }

                if (line.includes('ステータスが上昇') || line.includes('ステータスが低下') || line.includes('ステータスが変化') || line.includes('状態異常が付与')) {
                    const statusTargetMatch = line.match(/^(.+?)\s*(?:の|に)\s.*?(ステータスが上昇|ステータスが低下|ステータスが変化|状態異常が付与された)/);
                    const target = statusTargetMatch ? statusTargetMatch[1].trim() : currentChar;
                    const nextLineInfo = getNextNonEmptyLine(lines, index + 1);
                    const summaryLine = nextLineInfo ? nextLineInfo.value : '';
                    const changeType = line.includes('上昇') ? 1 : line.includes('低下') ? -1 : 0;
                    const parsedStatus = parseStatusSummary(summaryLine, changeType);
                    parsedStatus.forEach(entry => {
                        recordReceivedStatusChange(stats, target, entry.name, entry.value, turnNum, currentChar);
                    });
                    if (nextLineInfo && parsedStatus.length > 0) {
                        index = nextLineInfo.index;
                    }
                }
                continue;
            }

            // SP 回復（HP 回復より先に判定。「SPを回復した」が HP 回復パターンにも一致してしまうため）
            const spRecovery = parseSPRecoveryLine(line);
            if (spRecovery) {
                aggregateSPHealing(stats, spRecovery.source || currentChar, spRecovery.target, spRecovery.recovery, turnNum);
                recordActionLog(stats, spRecovery.source || currentChar, turnNum, 'sp_heal', spRecovery.target, spRecovery.recovery, `${spRecovery.target} の SP を ${spRecovery.recovery} 回復`);
                continue;
            }

            // インライン形式のステータス変化（「ATK と MATK が 30 増加した」など）
            const inlineStatusChange = parseInlineStatusChangeLine(line, currentChar, currentChar);
            if (inlineStatusChange) {
                inlineStatusChange.entries.forEach(entry => {
                    recordReceivedStatusChange(stats, inlineStatusChange.target, entry.name, entry.value, turnNum, inlineStatusChange.source);
                });
                recordActionLog(stats, inlineStatusChange.source || currentChar, turnNum, 'status', inlineStatusChange.target, inlineStatusChange.entries.length, inlineStatusChange.entries.map(entry => `${entry.name} ${entry.value}`).join(', '));
                continue;
            }

            // ダメージ検出
            const damageInfo = parseDamageLine(line);
            if (damageInfo) {
                aggregateDamage(stats, currentChar, damageInfo.target, damageInfo.damage, turnNum);
                recordActionLog(stats, currentChar, turnNum, 'damage', damageInfo.target, damageInfo.damage, `${damageInfo.target} に ${damageInfo.damage} ダメージ`);
            }

            // HP回復
            const hpRecovery = parseHPRecoveryLine(line);
            if (hpRecovery) {
                aggregateHPHealing(stats, currentChar, hpRecovery.target, hpRecovery.recovery, turnNum);
                recordActionLog(stats, currentChar, turnNum, 'heal', hpRecovery.target, hpRecovery.recovery, `${hpRecovery.target} に ${hpRecovery.recovery} 回復`);
            }

            // 最大HP増加
            const hpIncMatch = line.match(/^(.+?) の最大HPが\s*\+\s*(\d+)\s*増加した/);
            if (hpIncMatch) {
                const target = hpIncMatch[1].trim();
                const increase = parseInt(hpIncMatch[2]);
                recordMaxHPIncrease(stats, target, increase, turnNum);
                recordActionLog(stats, currentChar, turnNum, 'max_hp', target, increase, `${target} の最大HP +${increase}`);
            }

            // ステータス変化ヘッダー行の処理
            // 形式: 「〇〇 の ステータスが上昇！」の次の非空行が「ATK +5 MATK +3」のような要約行
            // currentChar（発動者）を維持しつつ、ターゲットはヘッダー行から抽出する
            // 複数ターゲットへのデバフ（ブレイクダウンなど）でも currentChar は変わらない
            if (line.includes('ステータスが上昇') || line.includes('ステータスが低下') || line.includes('ステータスが変化') || line.includes('状態異常が付与')) {
                const statusTargetMatch = line.match(/^(.+?)\s*(?:の|に)\s.*?(ステータスが上昇|ステータスが低下|ステータスが変化|状態異常が付与された)/);
                const target = statusTargetMatch ? statusTargetMatch[1].trim() : currentChar;
                // 空行をまたいで次の要約行を取得する（ヘッダーと要約行の間に空行が入る場合がある）
                const nextLineInfo = getNextNonEmptyLine(lines, index + 1);
                const summaryLine = nextLineInfo ? nextLineInfo.value : '';
                const changeType = line.includes('上昇') ? 1 : line.includes('低下') ? -1 : 0;
                const parsedStatus = parseStatusSummary(summaryLine, changeType);
                parsedStatus.forEach(entry => {
                    recordReceivedStatusChange(stats, target, entry.name, entry.value, turnNum, currentChar);
                });
                if (parsedStatus.length > 0) {
                    recordActionLog(stats, currentChar, turnNum, 'status', target, parsedStatus.length, parsedStatus.map(entry => `${entry.name} ${entry.value}`).join(', '));
                }
                // 要約行を消費済みとしてインデックスを進める
                if (nextLineInfo && parsedStatus.length > 0) {
                    index = nextLineInfo.index;
                }
            }
        }
    }

    function turnHasStatusData(stats, turnNum) {
        return Object.values(stats).some(stat => {
            const turnData = stat.turns[turnNum] || {};
            return Boolean(
                (turnData.statusChangesSelf && Object.keys(turnData.statusChangesSelf).length > 0) ||
                (turnData.statusChangesOther && Object.keys(turnData.statusChangesOther).length > 0) ||
                (turnData.statusConditions && Object.keys(turnData.statusConditions).length > 0) ||
                (turnData.statusConditionsSelf && Object.keys(turnData.statusConditionsSelf).length > 0) ||
                (turnData.statusConditionsOther && Object.keys(turnData.statusConditionsOther).length > 0)
            );
        });
    }

    function aggregateStats(turns) {
        const stats = {};
        turns.forEach(turn => {
            parseActionsFromText(turn.content, stats, turn.turnNum);
        });
        return stats;
    }

    function recordActionLog(stats, actorName, turnNum, actionType, target, value, detailText) {
        Object.keys(stats).forEach(key => {
            if (stats[key].name !== actorName) {
                return;
            }
            if (!stats[key].turns[turnNum]) {
                stats[key].turns[turnNum] = {};
            }
            if (!Array.isArray(stats[key].turns[turnNum].actions)) {
                stats[key].turns[turnNum].actions = [];
            }
            stats[key].turns[turnNum].actions.push({
                turn: turnNum,
                actor: actorName,
                type: actionType,
                target: target || '-',
                value: value || 0,
                detail: detailText || ''
            });
        });
    }

    function aggregateDamage(stats, attacker, target, damage, turnNum) {
        Object.keys(stats).forEach(key => {
            if (stats[key].name === attacker) {
                if (!stats[key].summary.damageDealt[target]) {
                    stats[key].summary.damageDealt[target] = 0;
                }
                stats[key].summary.damageDealt[target] += damage;

                if (!stats[key].turns[turnNum]) {
                    stats[key].turns[turnNum] = {};
                }
                if (!stats[key].turns[turnNum].damageDealt) {
                    stats[key].turns[turnNum].damageDealt = {};
                }
                if (!stats[key].turns[turnNum].damageDealt[target]) {
                    stats[key].turns[turnNum].damageDealt[target] = 0;
                }
                stats[key].turns[turnNum].damageDealt[target] += damage;
                recordActionLog(stats, attacker, turnNum, 'damage', target, damage, `${target} に ${damage} ダメージ`);
            }
        });
    }

    function aggregateHPHealing(stats, healer, target, recovery, turnNum) {
        Object.keys(stats).forEach(key => {
            if (stats[key].name === healer) {
                if (!stats[key].summary.hpHealed[target]) {
                    stats[key].summary.hpHealed[target] = 0;
                }
                stats[key].summary.hpHealed[target] += recovery;

                if (!stats[key].turns[turnNum]) {
                    stats[key].turns[turnNum] = {};
                }
                if (!stats[key].turns[turnNum].hpHealed) {
                    stats[key].turns[turnNum].hpHealed = {};
                }
                if (!stats[key].turns[turnNum].hpHealed[target]) {
                    stats[key].turns[turnNum].hpHealed[target] = 0;
                }
                stats[key].turns[turnNum].hpHealed[target] += recovery;
                recordActionLog(stats, healer, turnNum, 'heal', target, recovery, `${target} に ${recovery} 回復`);
            }
        });
    }

    function aggregateSPHealing(stats, healer, target, recovery, turnNum) {
        Object.keys(stats).forEach(key => {
            if (stats[key].name === healer) {
                if (!stats[key].summary.spHealed[target]) {
                    stats[key].summary.spHealed[target] = 0;
                }
                stats[key].summary.spHealed[target] += recovery;

                if (!stats[key].turns[turnNum]) {
                    stats[key].turns[turnNum] = {};
                }
                if (!stats[key].turns[turnNum].spHealed) {
                    stats[key].turns[turnNum].spHealed = {};
                }
                if (!stats[key].turns[turnNum].spHealed[target]) {
                    stats[key].turns[turnNum].spHealed[target] = 0;
                }
                stats[key].turns[turnNum].spHealed[target] += recovery;
                recordActionLog(stats, healer, turnNum, 'sp_heal', target, recovery, `${target} の SP を ${recovery} 回復`);
            }
        });
    }

    // キャラクターが受けたステータス変化を summary とターン別データの両方に記録する
    // trackedStatusFields に含まれる項目（ATK/DEF 等）は数値加算で累計し、
    // それ以外の項目（状態異常名）は上書きで最新値を保持する
    // source === character なら「自己バフ/デバフ」、異なれば「他者による影響」に分類する
    function recordReceivedStatusChange(stats, character, statName, change, turnNum, source) {
        Object.keys(stats).forEach(key => {
            if (stats[key].name === character) {
                const isSelf = source && source === character;
                const isTracked = trackedStatusFields.includes(statName);
                const summaryKey = isTracked ? 'statusChangesReceived' : 'statusConditionsReceived';
                const selfKey = isTracked
                    ? (isSelf ? 'statusChangesReceivedSelf' : 'statusChangesReceivedOther')
                    : (isSelf ? 'statusConditionsReceivedSelf' : 'statusConditionsReceivedOther');

                if (!stats[key].summary[summaryKey][statName]) {
                    stats[key].summary[summaryKey][statName] = 0;
                }
                if (isTracked) {
                    stats[key].summary[summaryKey][statName] += change;
                } else {
                    stats[key].summary[summaryKey][statName] = change;
                }

                if (!stats[key].summary[selfKey][statName]) {
                    stats[key].summary[selfKey][statName] = 0;
                }
                if (isTracked) {
                    stats[key].summary[selfKey][statName] += change;
                } else {
                    stats[key].summary[selfKey][statName] = change;
                }

                if (!stats[key].turns[turnNum]) {
                    stats[key].turns[turnNum] = {};
                }
                const turnKey = isTracked
                    ? (isSelf ? 'statusChangesSelf' : 'statusChangesOther')
                    : (isSelf ? 'statusConditionsSelf' : 'statusConditionsOther');
                if (!stats[key].turns[turnNum][turnKey]) {
                    stats[key].turns[turnNum][turnKey] = {};
                }
                stats[key].turns[turnNum][turnKey][statName] = (stats[key].turns[turnNum][turnKey][statName] || 0) + change;
            }
        });
    }

    function recordMaxHPIncrease(stats, character, increase, turnNum) {
        Object.keys(stats).forEach(key => {
            if (stats[key].name === character) {
                stats[key].summary.maxHPIncreases += increase;

                if (!stats[key].turns[turnNum]) {
                    stats[key].turns[turnNum] = {};
                }
                if (!stats[key].turns[turnNum].maxHPIncreases) {
                    stats[key].turns[turnNum].maxHPIncreases = 0;
                }
                stats[key].turns[turnNum].maxHPIncreases += increase;
            }
        });
    }

    function displayStats(stats) {
        if (!stats || Object.keys(stats).length === 0) {
            console.error('No stat data found to display');
            return;
        }

        const existing = document.getElementById('battlelog-stats');
        if (existing) {
            existing.remove();
        }

        const statsList = Object.values(stats).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        const allyStats = statsList.filter(s => s.team === 'ally');
        const enemyStats = statsList.filter(s => s.team === 'enemy');
        const allStats = [...allyStats, ...enemyStats];
        const totalTurns = Math.max(1, ...allStats.map(s => Object.keys(s.turns).length));

        const root = document.createElement('div');
        root.id = 'battlelog-overlay-root';
        root.style.cssText = `
            position: fixed;
            top: 18px;
            left: 18px;
            right: 18px;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 16px;
            z-index: 2147483647;
            pointer-events: none;
        `;

        const container = document.createElement('div');
        container.id = 'battlelog-stats';
        container.style.cssText = `
            position: relative;
            width: min(980px, calc(100vw - 220px));
            max-width: 980px;
            margin-left: auto;
            padding: 14px;
            box-sizing: border-box;
            background: linear-gradient(135deg, rgba(246,247,251,0.98) 0%, rgba(238,242,248,0.98) 100%);
            border: 3px solid #2d3642;
            border-radius: 12px;
            box-shadow: 0 18px 50px rgba(30, 39, 52, 0.18);
            font-family: "Segoe UI", "Yu Gothic", sans-serif;
            color: #1d2733 !important;
            pointer-events: auto;
            height: calc(100vh - 36px);
            max-height: calc(100vh - 36px);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        `;

        const style = document.createElement('style');
        style.textContent = `
            #battlelog-stats,
            #battlelog-stats *,
            #battlelog-stats *::before,
            #battlelog-stats *::after {
                color: #1d2733 !important;
                background-color: transparent !important;
                border-color: #dfe7f2 !important;
                box-shadow: none !important;
                text-shadow: none !important;
                font-family: "Segoe UI", "Yu Gothic", sans-serif !important;
            }
            #battlelog-overlay-root {
                pointer-events: none;
            }
            #battlelog-overlay-root > * {
                pointer-events: auto;
            }
            #battlelog-overlay-root {
                width: calc(100vw - 36px);
                max-width: calc(100vw - 36px);
            }
            #battlelog-stats {
                margin-left: auto;
                display: flex;
                flex-direction: column;
                height: calc(100vh - 36px);
                max-height: calc(100vh - 36px);
            }
            #battlelog-rail {
                width: 120px;
                min-width: 120px;
                max-height: calc(100vh - 120px);
                background: rgba(255,255,255,0.85);
                border: 1px solid #dfe7f2;
                border-radius: 12px;
                padding: 10px 8px;
                box-sizing: border-box;
                overflow-y: auto;
                overflow-x: hidden;
                position: relative;
                flex-shrink: 0;
                display: flex;
                flex-direction: column;
                align-items: stretch;
                margin-right: 0;
                scrollbar-gutter: stable;
            }
            #battlelog-rail {
                display: flex;
                flex-direction: column;
                justify-content: flex-start;
            }
            #battlelog-rail .battlelog-rail-group {
                margin-bottom: 12px;
            }
            #battlelog-rail .battlelog-rail-group-title {
                font-size: 10px;
                color: #6a7889;
                font-weight: 700;
                text-align: center;
                letter-spacing: 0.08em;
                margin-bottom: 8px;
            }
            #battlelog-rail .battlelog-rail-item {
                width: 100%;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 6px;
                padding: 8px 4px 7px;
                margin-bottom: 8px;
                border: 1px solid #dfe7f2;
                border-radius: 12px;
                background: #fff;
                cursor: pointer;
                transition: all 0.15s ease;
                text-align: center;
                min-height: 76px;
            }
            #battlelog-rail .battlelog-rail-item:hover {
                border-color: #8ea9ff;
                background: #f5f8ff;
            }
            #battlelog-rail .battlelog-rail-item.selected {
                background: #edf4ff !important;
                border-color: #8ea9ff !important;
                box-shadow: inset 0 0 0 1px rgba(73, 112, 255, 0.18) !important;
            }
            #battlelog-rail .battlelog-rail-icon {
                width: 42px;
                height: 42px;
                min-width: 42px;
                min-height: 42px;
                border-radius: 12px;
                background: linear-gradient(135deg, #2e74ff 0%, #5ca5ff 100%);
                color: #fff !important;
                font-weight: 800;
                font-size: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                line-height: 1;
                flex-shrink: 0;
                letter-spacing: 0;
            }
            #battlelog-rail .battlelog-rail-item[data-team="enemy"] .battlelog-rail-icon {
                background: linear-gradient(135deg, #ff7d67 0%, #ff4e5b 100%);
            }
            #battlelog-rail .battlelog-rail-item[data-summary="true"] .battlelog-rail-icon {
                background: linear-gradient(135deg, #7f8dff 0%, #622ad1 100%);
            }
            #battlelog-rail .battlelog-rail-name {
                display: block;
                width: 100%;
                font-size: 11px;
                line-height: 1.3;
                min-height: 2.6em;
                color: #1d2733 !important;
                word-break: break-word;
                overflow-wrap: anywhere;
            }
            #battlelog-stats .battlelog-detail-panel {
                flex: 1 1 auto;
                min-width: 0;
                width: 100%;
                max-width: none;
                background: rgba(255,255,255,0.8);
                border: 1px solid #dfe7f2;
                border-radius: 12px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                margin-left: 0;
                min-height: 0;
                height: 100%;
            }
            #battlelog-stats .battlelog-detail-panel.collapsed {
                display: none;
            }
            #battlelog-stats .battlelog-detail-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 14px;
                border-bottom: 1px solid #dfe7f2;
                background: rgba(245,248,255,0.9);
            }
            #battlelog-stats .battlelog-detail-title {
                font-size: 14px;
                font-weight: 700;
                color: #1d2733 !important;
            }
            #battlelog-stats .battlelog-close-btn {
                width: 30px;
                height: 30px;
                border: 1px solid #dfe7f2;
                border-radius: 9px;
                background: #fff;
                color: #37465d !important;
                font-size: 18px;
                cursor: pointer;
                line-height: 1;
            }
            #battlelog-stats .battlelog-detail-body {
                flex: 1 1 auto;
                overflow-y: auto;
                overflow-x: hidden;
                padding: 14px;
                box-sizing: border-box;
                min-height: 0;
                max-height: none;
                height: 100%;
            }
            #battlelog-stats button,
            #battlelog-stats td,
            #battlelog-stats th,
            #battlelog-stats div,
            #battlelog-stats span,
            #battlelog-stats strong,
            #battlelog-stats h2,
            #battlelog-stats h3,
            #battlelog-stats p,
            #battlelog-stats label {
                color: inherit !important;
            }
            #battlelog-stats .battlelog-muted,
            #battlelog-stats [style*="color:#4f5d6d"],
            #battlelog-stats [style*="color:#516177"],
            #battlelog-stats [style*="color:#5b6979"],
            #battlelog-stats [style*="color:#243447"] {
                color: #4f5d6d !important;
            }
        `;
        document.head.appendChild(style);

        const leftRail = document.createElement('nav');
        leftRail.id = 'battlelog-rail';
        leftRail.className = 'rail battlelog-rail';
        leftRail.setAttribute('aria-label', 'ログビューア');

        const rightPanel = document.createElement('section');
        rightPanel.className = 'battlelog-detail-panel';

        const detailHeader = document.createElement('div');
        detailHeader.className = 'battlelog-detail-header';
        const detailTitle = document.createElement('div');
        detailTitle.className = 'battlelog-detail-title';
        detailTitle.textContent = '統計情報';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'battlelog-close-btn';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', '統計情報を閉じる');
        closeBtn.textContent = '✕';
        detailHeader.appendChild(detailTitle);
        detailHeader.appendChild(closeBtn);

        const detailBody = document.createElement('div');
        detailBody.className = 'battlelog-detail-body';
        detailBody.innerHTML = renderOverallSummaryPanel(allStats);
        rightPanel.appendChild(detailHeader);
        rightPanel.appendChild(detailBody);

        const renderItems = (teamStats, teamLabel) => {
            const items = teamStats.map(stat => {
                const key = `${stat.team}:${stat.name}`;
                const initial = (stat.name || '').charAt(0) || '？';
                return `
                    <button type="button" class="battlelog-rail-item" data-character-key="${key}" data-team="${stat.team}" data-summary="false" aria-label="${stat.name}の統計を表示">
                        <span class="battlelog-rail-icon">${initial}</span>
                        <span class="battlelog-rail-name">${stat.name}</span>
                    </button>
                `;
            }).join('');
            return items ? `
                <div class="battlelog-rail-group">
                    <div class="battlelog-rail-group-title">${teamLabel}</div>
                    ${items}
                </div>
            ` : '';
        };

        leftRail.innerHTML = `
            ${renderItems(allyStats, '味方')}
            ${renderItems(enemyStats, '敵')}
            <div class="battlelog-rail-group">
                <button type="button" class="battlelog-rail-item" data-summary="true" data-character-key="summary" data-team="all" aria-label="統計情報を表示">
                    <span class="battlelog-rail-icon">Σ</span>
                    <span class="battlelog-rail-name">統計情報</span>
                </button>
            </div>
        `;

        const setPanelVisible = (visible) => {
            container.style.display = visible ? 'block' : 'none';
            leftRail.style.opacity = visible ? '1' : '0.7';
        };

        const activateSelection = (key, mode = 'character') => {
            const selectedNode = leftRail.querySelector('[data-character-key="' + key + '"]');
            leftRail.querySelectorAll('.battlelog-rail-item').forEach(node => {
                node.classList.toggle('selected', node === selectedNode);
            });

            setPanelVisible(true);

            if (mode === 'summary') {
                detailTitle.textContent = '統計情報';
                detailBody.innerHTML = renderOverallSummaryPanel(allStats);
                rightPanel.classList.remove('collapsed');
                return;
            }

            const item = Object.values(stats).find(character => `${character.team}:${character.name}` === key) || allStats[0];
            if (!item) {
                return;
            }
            const tab = rightPanel.querySelector('[data-tab-active="true"]')?.getAttribute('data-tab') || 'actions';
            detailTitle.textContent = `${item.team === 'ally' ? '味方' : '敵'} / ${item.name}`;
            detailBody.innerHTML = renderCharacterDetail(item, allStats, tab);
            rightPanel.classList.remove('collapsed');
        };

        leftRail.addEventListener('click', (event) => {
            const target = event.target.closest('.battlelog-rail-item');
            if (!target) {
                return;
            }
            const key = target.getAttribute('data-character-key');
            const isSummary = target.getAttribute('data-summary') === 'true';
            if (isSummary) {
                activateSelection('summary', 'summary');
                return;
            }
            activateSelection(key, 'character');
        });

        rightPanel.addEventListener('click', event => {
            const tabButton = event.target.closest('[data-tab]');
            if (tabButton) {
                const selectedKey = leftRail.querySelector('.battlelog-rail-item.selected')?.getAttribute('data-character-key');
                if (!selectedKey || selectedKey === 'summary') {
                    return;
                }
                const selectedItem = Object.values(stats).find(character => `${character.team}:${character.name}` === selectedKey) || allStats[0];
                const tab = tabButton.getAttribute('data-tab');
                detailTitle.textContent = `${selectedItem.team === 'ally' ? '味方' : '敵'} / ${selectedItem.name}`;
                detailBody.innerHTML = renderCharacterDetail(selectedItem, allStats, tab);
                rightPanel.querySelectorAll('[data-tab]').forEach(node => node.setAttribute('data-tab-active', node === tabButton ? 'true' : 'false'));
                return;
            }
            if (event.target.closest('.battlelog-close-btn')) {
                setPanelVisible(false);
            }
        });

        closeBtn.addEventListener('click', () => {
            setPanelVisible(false);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && container.style.display !== 'none') {
                setPanelVisible(false);
            }
        });

        container.appendChild(rightPanel);
        root.appendChild(leftRail);
        root.appendChild(container);
        document.body.appendChild(root);

        setPanelVisible(false);

        const originalPage = document.body;
        if (originalPage) {
            originalPage.style.position = 'relative';
            originalPage.style.zIndex = '0';
        }

        console.log('Stats initialized in collapsed state');
    }

    function renderOverallSummaryPanel(statsList) {
        const totalTurns = Math.max(1, ...statsList.map(stat => Object.keys(stat.turns || {}).length));
        return `
            <div style="display:flex; flex-direction:column; gap:14px; width:100%;">
                <div style="font-size: 13px; font-weight: 700; color: #1d2733;">全体統計</div>
                <div style="display:flex; flex-direction:column; gap:14px; width:100%;">
                    <div style="width:100%;">${renderTurnTotalsChart(statsList)}</div>
                    <div style="width:100%;">${renderHPChart(statsList)}</div>
                </div>
                <div style="font-size: 12px; color:#4f5d6d; font-weight:700;">キャラ別一覧</div>
                <div>${renderOverallStatsTable(statsList)}</div>
                <div style="font-size: 12px; color:#4f5d6d; font-weight:700;">キャラクター一覧</div>
                <div>${renderCharacterList(statsList, totalTurns)}</div>
            </div>
        `;
    }

    function renderCharacterList(statsList, totalTurns) {
        const rows = statsList
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
            .map(stat => {
                const summary = getCharacterSummary(stat, statsList);
                const key = `${stat.team}:${stat.name}`;
                const damage = summary.totalDamage;
                const heal = summary.totalHeal;
                const receivedDamage = summary.totalReceivedDamage;
                const label = stat.team === 'ally' ? '味方' : '敵';
                return `
                    <button data-character-key="${key}" style="display:block; width:100%; margin:0 0 8px; padding:9px 10px; border:1px solid #d6deea; border-radius:10px; background:#fff; text-align:left; cursor:pointer; color:#1d2733; box-sizing:border-box;">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:4px;">
                            <strong>${label} ${stat.name}</strong>
                            <span style="font-size:11px; color:#5b6979;">${summary.turnCount}T</span>
                        </div>
                        <div style="font-size:12px; color:#516177; line-height:1.6;">
                            <span>与ダメ ${damage}</span> / <span>被ダメ ${receivedDamage}</span><br>
                            <span>回復 ${heal}</span> / <span>最大HP+${stat.summary.maxHPIncreases}</span>
                        </div>
                    </button>
                `;
            })
            .join('');

        return `<div style="display:flex; flex-direction:column;">${rows}</div>`;
    }

    function renderOverallStatsTable(statsList) {
        const rows = statsList
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
            .map(stat => {
                const summary = getCharacterSummary(stat, statsList);
                return `
                    <tr>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${stat.name}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.totalDamage}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.dpt.toFixed(1)}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.dpa.toFixed(1)}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.totalReceivedDamage}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.tdpt.toFixed(1)}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.totalHeal}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.hpt.toFixed(1)}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.hpa.toFixed(1)}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${summary.totalReceivedHeal}</td>
                        <td style="padding:7px 6px; border:1px solid #dfe7f2;">${stat.summary.maxHPIncreases}</td>
                    </tr>
                `;
            })
            .join('');

        return `
            <div style="overflow:auto; margin-top: 10px;">
                <table style="width:100%; border-collapse:collapse; font-size: 12px; min-width: 840px;">
                    <thead>
                        <tr>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">キャラ</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">与ダメ</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">DPT</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">DPA</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">被ダメ</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">TDPT</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">与回復</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">HPT</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">HPA</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">被回復</th>
                            <th style="padding:7px 6px; border:1px solid #dfe7f2; background:#edf3ff;">最大HP増加</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }

    function renderTurnTotalsChart(statsList) {
        const turnNumbers = Array.from(new Set(statsList.flatMap(stat => Object.keys(stat.turns).map(n => Number(n))))).sort((a, b) => a - b);
        const allyData = turnNumbers.map(turn => {
            return statsList
                .filter(stat => stat.team === 'ally')
                .reduce((sum, stat) => sum + sumDamageByTurn(stat, turn), 0);
        });
        const enemyData = turnNumbers.map(turn => {
            return statsList
                .filter(stat => stat.team === 'enemy')
                .reduce((sum, stat) => sum + sumDamageByTurn(stat, turn), 0);
        });
        const maxValue = Math.max(1, ...allyData.concat(enemyData));
        const chart = createSvgLineChart([
            { label: '味方', values: allyData, color: '#3c80ff' },
            { label: '敵', values: enemyData, color: '#ff6a5b' }
        ], { width: 460, height: 220, maxValue: maxValue, labels: turnNumbers });
        return `
            <div style="background:#fff; border:1px solid #dfe7f2; border-radius:10px; padding:8px; width:100%; box-sizing:border-box;"><div style="font-size:12px; font-weight:700; margin-bottom:6px; color:#273547;">ターン別与ダメ合計</div>${chart}</div>
        `;
    }

    function renderHPChart(statsList) {
        const turnNumbers = Array.from(new Set(statsList.flatMap(stat => Object.keys(stat.turns).map(n => Number(n))))).sort((a, b) => a - b);
        const series = statsList
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
            .map(stat => ({
                label: stat.name,
                values: turnNumbers.map(turn => {
                    const turnData = stat.turns[turn] || {};
                    return typeof turnData.hpCurrent === 'number' ? turnData.hpCurrent : 0;
                }),
                color: stat.team === 'ally' ? '#3c80ff' : '#ff6a5b'
            }))
            .filter(seriesItem => seriesItem.values.some(value => value > 0));
        const maxValue = Math.max(1, ...series.flatMap(item => item.values));
        return `
            <div style="background:#fff; border:1px solid #dfe7f2; border-radius:10px; padding:8px; width:100%; box-sizing:border-box;"><div style="font-size:12px; font-weight:700; margin-bottom:6px; color:#273547;">HP推移</div>${createSvgLineChart(series, { width: 460, height: 220, maxValue: maxValue, labels: turnNumbers })}</div>
        `;
    }

    function createSvgLineChart(seriesList, options = {}) {
        const width = options.width || 300;
        const height = options.height || 140;
        const padding = 22;
        const labels = options.labels || [];
        const maxValue = Math.max(1, options.maxValue || 1);
        const innerWidth = width - padding * 2;
        const innerHeight = height - padding * 2;
        const yTicks = 5;

        const formatValue = (value) => {
            if (!Number.isFinite(value)) {
                return '0';
            }
            return Number.isInteger(value) ? String(value) : value.toFixed(1);
        };

        const pointMap = (values) => values.map((value, index) => {
            const x = padding + (labels.length > 1 ? index * (innerWidth / (labels.length - 1)) : innerWidth / 2);
            const y = height - padding - ((value / maxValue) * innerHeight || 0);
            return { x, y, value };
        });

        const grid = Array.from({ length: yTicks }, (_, index) => {
            const ratio = index / (yTicks - 1);
            const y = padding + ratio * innerHeight;
            const tickValue = maxValue * (1 - ratio);
            return `
                <g>
                    <line x1="${padding}" x2="${width - padding}" y1="${y}" y2="${y}" stroke="#c5ccdb" stroke-width="1.2" stroke-dasharray="0" />
                    <text x="${padding - 6}" y="${y + 3}" text-anchor="end" font-size="8" fill="#68798d">${formatValue(tickValue)}</text>
                </g>
            `;
        }).join('');

        const axis = `
            <line x1="${padding}" x2="${padding}" y1="${padding}" y2="${height - padding}" stroke="#9aa9b7" />
            <line x1="${padding}" x2="${width - padding}" y1="${height - padding}" y2="${height - padding}" stroke="#9aa9b7" />
        `;

        const lines = seriesList.map(item => {
            const dataPoints = pointMap(item.values);
            const points = dataPoints.map(point => `${point.x},${point.y}`).join(' ');
            const dots = dataPoints.map(point => `
                <g>
                    <circle cx="${point.x}" cy="${point.y}" r="3.5" fill="${item.color || '#4b7bec'}" stroke="#fff" stroke-width="1.2">
                        <title>${item.label || '値'}: ${formatValue(point.value)}</title>
                    </circle>
                </g>
            `).join('');
            return `
                <g>
                    <polyline fill="none" stroke="${item.color || '#4b7bec'}" stroke-width="2" points="${points}" stroke-linecap="round" stroke-linejoin="round" />
                    ${dots}
                </g>
            `;
        }).join('');

        const labelsHtml = labels.map((label, index) => {
            const x = padding + (labels.length > 1 ? index * (innerWidth / (labels.length - 1)) : 0);
            return `<text x="${x}" y="${height - 4}" text-anchor="middle" font-size="8" fill="#68798d">${label}</text>`;
        }).join('');

        return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="display:block; width:100%; height:auto;">${grid}${axis}${lines}${labelsHtml}</svg>`;
    }

    function getCharacterSummary(stat, statsList) {
        const totalDamage = Object.values(stat.summary.damageDealt).reduce((sum, value) => sum + value, 0);
        const totalHeal = Object.values(stat.summary.hpHealed).reduce((sum, value) => sum + value, 0);
        const totalReceivedDamage = Object.values(statsList)
            .reduce((sum, eachStat) => sum + (eachStat.summary.damageDealt[stat.name] || 0), 0);
        const totalReceivedHeal = Object.values(statsList)
            .reduce((sum, eachStat) => sum + (eachStat.summary.hpHealed[stat.name] || 0), 0);
        const turnCount = Object.keys(stat.turns).length || 1;
        const actionCount = Object.values(stat.turns).reduce((sum, turnData) => sum + Object.keys(turnData.damageDealt || {}).length, 0);
        const healActions = Object.values(stat.turns).reduce((sum, turnData) => sum + Object.keys(turnData.hpHealed || {}).length, 0);

        return {
            totalDamage,
            totalHeal,
            totalReceivedDamage,
            totalReceivedHeal,
            dpt: totalDamage / Math.max(turnCount, 1),
            tdpt: totalReceivedDamage / Math.max(turnCount, 1),
            dpa: actionCount > 0 ? totalDamage / actionCount : 0,
            hpt: totalHeal / Math.max(turnCount, 1),
            hpa: healActions > 0 ? totalHeal / healActions : 0,
            turnCount
        };
    }

    function sumDamageByTurn(stat, turnNumber) {
        const turnData = stat.turns[turnNumber] || {};
        return Object.values(turnData.damageDealt || {}).reduce((sum, value) => sum + value, 0);
    }

    function renderCharacterDetail(stat, statsList, tabKey) {
        const tabs = [
            { key: 'actions', label: '行動一覧' },
            { key: 'damageBreakdown', label: '与ダメ内訳' },
            { key: 'damageTaken', label: '被ダメ内訳' },
            { key: 'hpProgress', label: 'HP推移' },
            { key: 'statusTrend', label: '変調推移' },
            { key: 'statusStats', label: 'ステータス推移' },
            { key: 'damageTrend', label: '与ダメ推移' },
            { key: 'healTrend', label: '与回復推移' }
        ];

        const usedTab = tabs.some(tab => tab.key === tabKey) ? tabKey : 'actions';
        const tabButtons = tabs.map(tab => `
            <button data-tab="${tab.key}" data-tab-active="${tab.key === usedTab ? 'true' : 'false'}" style="padding:8px 10px; border:1px solid #dfe7f2; border-radius:8px; background:${tab.key === usedTab ? '#eaf1ff' : '#fff'}; color:#23364d; cursor:pointer; margin-right:8px; margin-bottom:8px;">
                ${tab.label}
            </button>
        `).join('');

        return `
            <div style="margin-bottom: 14px; font-size: 13px; font-weight: 700; color:#1d2733;">${stat.team === 'ally' ? '味方' : '敵'} / ${stat.name}</div>
            <div style="margin-bottom: 12px;">${tabButtons}</div>
            <div style="background:#fff; border:1px solid #dfe7f2; border-radius:10px; padding:12px; box-sizing:border-box;">${renderCharacterTab(stat, statsList, usedTab)}</div>
        `;
    }

    function renderCharacterTab(stat, statsList, tabKey) {
        const turnNumbers = Object.keys(stat.turns).map(Number).sort((a, b) => a - b);
        const fullDamageBreakdown = Object.entries(stat.summary.damageDealt || {}).sort((a, b) => b[1] - a[1]);
        const fullHealBreakdown = Object.entries(stat.summary.hpHealed || {}).sort((a, b) => b[1] - a[1]);
        const receivedDamageBreakdown = statsList
            .reduce((map, eachStat) => {
                const value = (eachStat.summary && eachStat.summary.damageDealt && eachStat.summary.damageDealt[stat.name]) || 0;
                if (value > 0) {
                    map.push([eachStat.name, value]);
                }
                return map;
            }, [])
            .sort((a, b) => b[1] - a[1]);
        const statusMatrix = buildRunningStatusFieldMatrix(stat, turnNumbers);

        if (tabKey === 'actions') {
            const actionRows = turnNumbers.flatMap(turn => {
                const entries = stat.turns[turn]?.actions || [];
                return entries.map(entry => ({
                    turn,
                    type: entry.type,
                    target: entry.target,
                    value: entry.value,
                    detail: entry.detail
                }));
            });
            if (actionRows.length === 0) {
                return '<div style="font-size:13px; color:#4a5b70;">行動情報はありません。</div>';
            }
            return `
                <table style="width:100%; border-collapse:collapse; font-size:12px;">
                    <thead><tr><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">ターン</th><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">行動</th><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">対象</th><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">値</th><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">詳細</th></tr></thead>
                    <tbody>${actionRows.map(row => `<tr><td style="padding:7px; border:1px solid #dfe7f2;">${row.turn}</td><td style="padding:7px; border:1px solid #dfe7f2;">${({ damage: 'ダメージ', heal: '回復', sp_heal: 'SP回復', max_hp: '最大HP増加' })[row.type] || row.type}</td><td style="padding:7px; border:1px solid #dfe7f2;">${row.target}</td><td style="padding:7px; border:1px solid #dfe7f2;">${row.value}</td><td style="padding:7px; border:1px solid #dfe7f2;">${row.detail}</td></tr>`).join('')}</tbody>
                </table>
            `;
        }

        if (tabKey === 'damageBreakdown') {
            if (fullDamageBreakdown.length === 0) {
                return '<div style="font-size:13px; color:#4a5b70;">与ダメ情報はありません。</div>';
            }
            return `
                <table style="width:100%; border-collapse:collapse; font-size:12px;">
                    <thead><tr><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">対象</th><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">合計</th></tr></thead>
                    <tbody>${fullDamageBreakdown.map(([target, value]) => `<tr><td style="padding:7px; border:1px solid #dfe7f2;">${target}</td><td style="padding:7px; border:1px solid #dfe7f2;">${value}</td></tr>`).join('')}</tbody>
                </table>
            `;
        }

        if (tabKey === 'damageTaken') {
            if (receivedDamageBreakdown.length === 0) {
                return '<div style="font-size:13px; color:#4a5b70;">被ダメ情報はありません。</div>';
            }
            return `
                <table style="width:100%; border-collapse:collapse; font-size:12px;">
                    <thead><tr><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">対象</th><th style="padding:7px; border:1px solid #dfe7f2; background:#edf3ff;">合計</th></tr></thead>
                    <tbody>${receivedDamageBreakdown.map(([target, value]) => `<tr><td style="padding:7px; border:1px solid #dfe7f2;">${target}</td><td style="padding:7px; border:1px solid #dfe7f2;">${value}</td></tr>`).join('')}</tbody>
                </table>
            `;
        }

        if (tabKey === 'hpProgress') {
            const values = turnNumbers.map(turn => stat.turns[turn] && typeof stat.turns[turn].hpCurrent === 'number' ? stat.turns[turn].hpCurrent : 0);
            const maxValue = Math.max(1, ...values, stat.summary.maxHPIncreases || 1);
            const chart = createSvgLineChart([{ label: stat.name, values, color: '#3c80ff' }], { width: 680, height: 180, maxValue, labels: turnNumbers });
            return `
                <div style="font-size:12px; color:#4a5b70; margin-bottom:8px;">HP推移（ターンごとの残りHP）</div>
                ${chart}
            `;
        }

        if (tabKey === 'statusTrend') {
            const conditionMatrix = buildConditionTrendMatrix(stat, turnNumbers);
            if (conditionMatrix.length === 0) {
                return '<div style="font-size:13px; color:#4a5b70;">変調情報はありません。</div>';
            }
            return `
                <div style="font-size:12px; color:#4a5b70; margin-bottom:8px;">変調推移（ターン別）</div>
                <table style="width:100%; border-collapse:collapse; font-size:12px;">
                    <thead><tr><th style="padding:7px; background:#edf3ff; border:1px solid #dfe7f2;">変調</th>${turnNumbers.map(turn => `<th style="padding:7px; background:#edf3ff; border:1px solid #dfe7f2;">${turn}</th>`).join('')}</tr></thead>
                    <tbody>${conditionMatrix.map(item => `<tr><td style="padding:7px; border:1px solid #dfe7f2;">${item.condition}</td>${item.values.map(value => `<td style="padding:7px; border:1px solid #dfe7f2;">${value === 0 ? '-' : value}</td>`).join('')}</tr>`).join('')}</tbody>
                </table>
            `;
        }

        if (tabKey === 'statusStats') {
            if (statusMatrix.every(item => item.row.every(v => v === 0))) {
                return '<div style="font-size:13px; color:#4a5b70;">ステータス変化情報はありません。</div>';
            }
            return `
                <table style="width:100%; border-collapse:collapse; font-size:12px;">
                    <thead><tr><th style="padding:7px; background:#edf3ff; border:1px solid #dfe7f2;">ステータス</th>${turnNumbers.map(turn => `<th style="padding:7px; background:#edf3ff; border:1px solid #dfe7f2;">${turn}</th>`).join('')}</tr></thead>
                    <tbody>${statusMatrix.map(item => `<tr><td style="padding:7px; border:1px solid #dfe7f2;">${item.field}</td>${item.row.map(value => `<td style="padding:7px; border:1px solid #dfe7f2;">${value === 0 ? '-' : value}</td>`).join('')}</tr>`).join('')}</tbody>
                </table>
            `;
        }

        if (tabKey === 'damageTrend') {
            const values = turnNumbers.map(turn => sumDamageByTurn(stat, turn));
            const maxValue = Math.max(1, ...values);
            const chart = createSvgLineChart([{ label: stat.name, values, color: '#ff6a5b' }], { width: 680, height: 180, maxValue, labels: turnNumbers });
            return `<div>${chart}</div>`;
        }

        if (tabKey === 'healTrend') {
            const values = turnNumbers.map(turn => sumHealByTurn(stat, turn));
            const maxValue = Math.max(1, ...values);
            const chart = createSvgLineChart([{ label: stat.name, values, color: '#2aa86b' }], { width: 680, height: 180, maxValue, labels: turnNumbers });
            return `<div>${chart}</div>`;
        }

        return `
            <table style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead><tr><th style="padding:7px; background:#edf3ff; border:1px solid #dfe7f2;">対象</th><th style="padding:7px; background:#edf3ff; border:1px solid #dfe7f2;">合計</th></tr></thead>
                <tbody>${fullDamageBreakdown.map(([target, value]) => `<tr><td style="padding:7px; border:1px solid #dfe7f2;">${target}</td><td style="padding:7px; border:1px solid #dfe7f2;">${value}</td></tr>`).join('') || '<tr><td style="padding:7px; border:1px solid #dfe7f2;" colspan="2">行動情報なし</td></tr>'}</tbody>
            </table>
        `;
    }

    function sumHealByTurn(stat, turnNumber) {
        const turnData = stat.turns[turnNumber] || {};
        return Object.values(turnData.hpHealed || {}).reduce((sum, value) => sum + value, 0);
    }

    function collectTurnSnapshots(stats) {
        const battleTurns = document.querySelectorAll('div.battle-turn');
        if (battleTurns.length === 0) {
            return;
        }

        battleTurns.forEach((turnNode, index) => {
            const heading = turnNode.querySelector('h3');
            const match = heading ? heading.textContent.trim().match(/ターン\s*(\d+)/) : null;
            const turnNum = match ? Number(match[1]) : null;
            if (!turnNum) {
                return;
            }

            const snapshotNode = battleTurns[index + 1] || turnNode;
            const tables = snapshotNode.querySelectorAll('table.battle-status-table');
            tables.forEach(table => {
                const className = table.className || '';
                const team = className.includes('ally-table') ? 'ally' : className.includes('enemy-table') ? 'enemy' : null;
                const rows = table.querySelectorAll('tbody tr');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 3) {
                        return;
                    }
                    const name = cells[1] ? cells[1].textContent.trim() : '';
                    if (!name || name === '名前') {
                        return;
                    }
                    const hpCell = cells[2];
                    const hpText = hpCell ? hpCell.textContent.trim() : '';
                    const hpMatch = hpText.match(/(\d+)\s*\/\s*(\d+)/);
                    const key = findStatsKeyByNameTeam(stats, name, team);
                    if (!key) {
                        return;
                    }
                    if (!stats[key].turns[turnNum]) {
                        stats[key].turns[turnNum] = {};
                    }
                    if (hpMatch) {
                        stats[key].turns[turnNum].hpCurrent = parseInt(hpMatch[1], 10);
                        stats[key].turns[turnNum].maxHP = parseInt(hpMatch[2], 10);
                    }
                    const statusText = cells[cells.length - 1] ? cells[cells.length - 1].textContent.trim() : '';
                    const conditionMap = parseConditionText(statusText);
                    if (Object.keys(conditionMap).length > 0) {
                        stats[key].turns[turnNum].statusConditions = conditionMap;
                    }
                });
            });
        });
    }

    function findStatsKeyByNameTeam(stats, name, team) {
        const candidates = Object.keys(stats).filter(key => stats[key].name === name);
        if (candidates.length === 0) {
            return null;
        }
        if (!team) {
            return candidates[0];
        }
        const exact = candidates.find(key => stats[key].team === team);
        return exact || candidates[0];
    }

    function renderCharacterSummary(statsList) {
        return renderOverallStatsTable(statsList);
    }

})();
