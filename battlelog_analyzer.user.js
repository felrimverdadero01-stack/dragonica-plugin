// ==UserScript==
// @name         ドラゴニカ対戦ログ集計ツール
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  対戦ログの各キャラクター行動を集計します
// @author       ゴニョマル
// @match        https://metropolis-c.sakura.ne.jp/teikigame/dragon1st/battlelogs/*.html
// @updateURL    https://github.com/felrimverdadero01-stack/dragonica-plugin/raw/main/battlelog_analyzer.user.js
// @downloadURL  https://github.com/felrimverdadero01-stack/dragonica-plugin/raw/main/battlelog_analyzer.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const trackedStatusFields = ['ATK','MATK','DEF','MDEF','SPD','HIT','MHIT','EVA','MEVA','HEAL','HATE','INTER'];

    if (document.readyState !== 'loading') {
        main();
    } else {
        document.addEventListener('DOMContentLoaded', main);
    }

    function main() {
        try {
            console.log('Script started');

            // テーブル要素から直接キャラクター情報を抽出
            let stats = extractCharactersFromDOM();

            if (stats && Object.keys(stats).length > 0) {
                console.log('DOM extraction successful. Found', Object.keys(stats).length, 'characters');
            } else {
                console.log('DOM extraction failed, trying text parsing');
                const battleLog = document.body.innerText;
                stats = extractCharactersFromText(battleLog);
                console.log('Text extraction found', Object.keys(stats).length, 'characters');

                if (Object.keys(stats).length === 0) {
                    console.log('Text extraction failed, trying action-based parsing');
                    stats = extractCharactersFromActions(battleLog);
                    console.log('Action-based extraction found', Object.keys(stats).length, 'characters');
                }
            }

            if (stats && Object.keys(stats).length > 0) {
                const domTurns = parseDOMTurns();
                if (domTurns.length > 0) {
                    aggregateDOMTurnActions(domTurns, stats);
                } else {
                    const textTurns = parseTextForActions(document.body.innerText);
                    aggregateActionsToStats(textTurns, stats);
                }
                parseFinalTurnStatusConditions(stats);
            }

            displayStats(stats);
        } catch (e) {
            console.error('Error in battle log analyzer:', e);
        }
    }

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

    function parseDOMTurns() {
        const turns = [];
        let currentTurn = 1;
        const nodes = Array.from(document.body.querySelectorAll('div.battle-turn, div.action-block'));

        nodes.forEach(node => {
            if (node.classList.contains('battle-turn')) {
                const heading = node.querySelector('h3');
                const text = heading ? heading.textContent.trim() : '';
                const match = text.match(/ターン\s*(\d+)/);
                if (match) {
                    currentTurn = parseInt(match[1], 10);
                }
                if (!turns.some(turn => turn.turnNum === currentTurn)) {
                    turns.push({turnNum: currentTurn, actionBlocks: []});
                }
                return;
            }

            if (node.classList.contains('action-block')) {
                let turn = turns.find(turn => turn.turnNum === currentTurn);
                if (!turn) {
                    turn = {turnNum: currentTurn, actionBlocks: []};
                    turns.push(turn);
                }
                turn.actionBlocks.push(node);
            }
        });

        return turns;
    }

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
                parseActionBlock(block, stats, turn.turnNum);
            });
        });
    }

    function aggregateActionsToStats(turnData, stats) {
        turnData.forEach(turn => {
            parseActionsFromText(turn.content, stats, turn.turnNum);
        });
    }

    function parseActionBlock(block, stats, turnNum) {
        const lines = Array.from(block.querySelectorAll('p'));
        if (lines.length === 0) {
            return;
        }

        const source = determineBlockSource(lines[0]);
        const sourceKey = findStatsKey(stats, source, block);
        if (!sourceKey) {
            return;
        }

        const actorName = stats[sourceKey].name;

        for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i].textContent.trim();
            if (!lineText) continue;

            const spRecovery = parseSPRecoveryLine(lineText);
            if (spRecovery) {
                aggregateSPHealing(stats, actorName, spRecovery.target, spRecovery.recovery, turnNum);
                continue;
            }

            const damageMatch = lineText.match(/の「(.+?)」が\s*(.+?)\s*に\s*([0-9,]+)\s*ダメージを与えた/);
            if (damageMatch) {
                const target = damageMatch[2].trim();
                const damage = parseInt(damageMatch[3].replace(/,/g, ''), 10);
                aggregateDamage(stats, actorName, target, damage, turnNum);
                continue;
            }

            if (lineText.includes('SP') && lineText.includes('回復した')) {
                continue;
            }

            const healMatch = lineText.match(/の「(.+?)」が\s*(.+?)\s*を\s*([0-9,]+)\s*回復した/);
            if (healMatch) {
                const target = healMatch[2].trim();
                const recovery = parseInt(healMatch[3].replace(/,/g, ''), 10);
                aggregateHPHealing(stats, actorName, target, recovery, turnNum);
                continue;
            }

            const hpIncMatch = lineText.match(/^(.+?) の最大HPが\s*\+\s*([0-9,]+)\s*増加した/);
            if (hpIncMatch) {
                const target = hpIncMatch[1].trim();
                const increase = parseInt(hpIncMatch[2].replace(/,/g, ''), 10);
                recordMaxHPIncrease(stats, target, increase, turnNum);
                continue;
            }

            const statusMatch = lineText.match(/^(.+?)\s*(?:の|に)\s.*?(ステータスが上昇|ステータスが低下|ステータスが変化|状態異常が付与された).*$/);
            if (statusMatch) {
                const target = statusMatch[1].trim();
                const summaryLine = lines[i + 1] ? lines[i + 1].textContent.trim() : '';
                const changeType = lineText.includes('上昇') ? 1 : lineText.includes('低下') ? -1 : 0;
                const parsedStatus = parseStatusSummary(summaryLine, changeType);
                parsedStatus.forEach(entry => {
                    recordReceivedStatusChange(stats, target, entry.name, entry.value, turnNum, actorName);
                });
                i += 1;
                continue;
            }
        }
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

    function parseStatusSummary(summaryText, changeType) {
        const entries = [];
        if (!summaryText) {
            return entries;
        }

        const numericRegex = /([A-Za-z0-9()]+)\s*([+-][0-9,]+)/g;
        let match;
        while ((match = numericRegex.exec(summaryText)) !== null) {
            entries.push({
                name: match[1].trim(),
                value: parseInt(match[2].replace(/,/g, ''), 10)
            });
        }

        if (entries.length > 0) {
            return entries;
        }

        const tokenRegex = /([^\s]+(?:\([^\)]*\))?)/g;
        while ((match = tokenRegex.exec(summaryText)) !== null) {
            const token = match[1].trim();
            if (token) {
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

    function parseSPRecoveryLine(lineText) {
        if (!lineText || !lineText.includes('回復')) {
            return null;
        }

        const patterns = [
            /^.*?([^\s]+)\s*の\s*SP(?:が|を)\s*([0-9,]+)\s*回復した/, 
            /^.*?([^\s]+)\s*の\s*SP回復(?:が|を)?\s*([0-9,]+)\s*回復した/
        ];

        for (const pattern of patterns) {
            const match = lineText.match(pattern);
            if (match) {
                return {
                    target: match[1].trim(),
                    recovery: parseInt(match[2].replace(/,/g, ''), 10)
                };
            }
        }

        return null;
    }

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

    function parseActionsFromText(turnContent, stats, turnNum) {
        const lines = turnContent.split('\n');
        let currentChar = null;
        const charNames = Object.values(stats).map(s => s.name).sort((a, b) => b.length - a.length);

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].trim();
            if (!line) continue;

            // キャラクター名の検出: 既知のキャラクター名を優先
            for (const name of charNames) {
                if (line.startsWith(`${name} の`) || line.startsWith(`${name}:`) || line.startsWith(`${name} `)) {
                    currentChar = name;
                    break;
                }
            }
            if (!currentChar) {
                const charMatch = line.match(/^([\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\-・_ａ-ｚA-Za-z0-9]+)\s*(?:の|:)/);
                if (charMatch) {
                    currentChar = charMatch[1].trim();
                }
            }

            if (!currentChar) continue;

            const spRecovery = parseSPRecoveryLine(line);
            if (spRecovery) {
                aggregateSPHealing(stats, currentChar, spRecovery.target, spRecovery.recovery, turnNum);
                continue;
            }

            // ダメージ検出
            const damageMatch = line.match(/「(.+?)」が\s*(.+?)\s*に\s*(\d+)\s*ダメージを与えた/);
            if (damageMatch) {
                const target = damageMatch[2].trim();
                const damage = parseInt(damageMatch[3]);
                aggregateDamage(stats, currentChar, target, damage, turnNum);
            }

            // HP回復
            const hpMatch = line.match(/「(.+?)」が\s*(.+?)\s*を\s*(\d+)\s*回復した/);
            if (hpMatch && !line.includes('SP')) {
                const target = hpMatch[2].trim();
                const recovery = parseInt(hpMatch[3]);
                aggregateHPHealing(stats, currentChar, target, recovery, turnNum);
            }

            // 最大HP増加
            const hpIncMatch = line.match(/^(.+?) の最大HPが\s*\+\s*(\d+)\s*増加した/);
            if (hpIncMatch) {
                const target = hpIncMatch[1].trim();
                const increase = parseInt(hpIncMatch[2]);
                recordMaxHPIncrease(stats, target, increase, turnNum);
            }

            // ステータス変化
            if (line.includes('ステータスが上昇') || line.includes('ステータスが低下') || line.includes('状態異常が付与')) {
                const statusTargetMatch = line.match(/^(.+?)\s*(?:の|に)\s.*?(ステータスが上昇|ステータスが低下|状態異常が付与された)/);
                const target = statusTargetMatch ? statusTargetMatch[1].trim() : currentChar;
                const type = line.includes('上昇') ? 'up' : line.includes('低下') ? 'down' : 'status';
                for (let i = index + 1; i < Math.min(index + 5, lines.length); i++) {
                    const statusLine = lines[i];
                    const statMatch = statusLine.match(/([A-Z]+)\s*([\+\-])(\d+)/);
                    if (statMatch) {
                        const statName = statMatch[1];
                        const sign = statMatch[2] === '+' ? 1 : -1;
                        const value = parseInt(statMatch[3], 10);
                        const change = sign * value;
                        recordReceivedStatusChange(stats, target, statName, change, turnNum, currentChar);
                    } else if (statusLine.trim() === '') {
                        break;
                    }
                }
            }
        }
    }

    function aggregateStats(turns) {
        const stats = {};
        turns.forEach(turn => {
            parseActionsFromText(turn.content, stats, turn.turnNum);
        });
        return stats;
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
            }
        });
    }

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

        const container = document.createElement('div');
        container.id = 'battlelog-stats';
        container.style.cssText = `
            position: relative;
            left: calc((100% - 100vw) / 2);
            width: 100vw;
            max-width: 100vw;
            margin: 20px auto;
            padding: 20px;
            box-sizing: border-box;
            border: 3px solid #333;
            background: linear-gradient(135deg, #f9f9f9 0%, #f0f0f0 100%);
            border-radius: 5px;
        `;

        const title = document.createElement('h2');
        title.textContent = '⚔️ 戦闘ログ集計情報';
        title.style.cssText = `
            border-bottom: 3px solid #333;
            padding-bottom: 15px;
            margin: 0 0 20px 0;
            color: #333;
        `;
        container.appendChild(title);

        const statsList = Object.values(stats);
        const allyStats = statsList.filter(s => s.team === 'ally').sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        const enemyStats = statsList.filter(s => s.team === 'enemy').sort((a, b) => a.name.localeCompare(b.name, 'ja'));

        if (allyStats.length > 0) {
            const allySection = document.createElement('div');
            const allyTitle = document.createElement('h3');
            allyTitle.textContent = '👥 味方チーム';
            allyTitle.style.cssText = 'color: #0066cc; border-bottom: 2px solid #0066cc; padding-bottom: 8px;';
            allySection.appendChild(allyTitle);
            allyStats.forEach(stat => {
                allySection.appendChild(createCharacterSection(stat));
            });
            container.appendChild(allySection);
        }

        if (enemyStats.length > 0) {
            const enemySection = document.createElement('div');
            const enemyTitle = document.createElement('h3');
            enemyTitle.textContent = '⚡ 敵チーム';
            enemyTitle.style.cssText = 'color: #cc0000; border-bottom: 2px solid #cc0000; padding-bottom: 8px;';
            enemySection.appendChild(enemyTitle);
            enemyStats.forEach(stat => {
                enemySection.appendChild(createCharacterSection(stat));
            });
            container.appendChild(enemySection);
        }

        document.body.appendChild(container);
        console.log('Stats displayed successfully');
    }

    function createCharacterSection(stat) {
        const section = document.createElement('div');
        section.style.cssText = `
            margin: 15px 0;
            padding: 15px;
            background: white;
            border-left: 5px solid #666;
            border-radius: 3px;
        `;

        const charTitle = document.createElement('h4');
        charTitle.textContent = '🎭 ' + stat.name;
        charTitle.style.cssText = 'margin: 0 0 10px 0; padding-bottom: 5px; border-bottom: 1px solid #999;';
        section.appendChild(charTitle);

        const summaryDiv = document.createElement('div');
        summaryDiv.style.cssText = `
            margin-top: 10px;
            padding: 10px;
            background: #f0f0f0;
            border-radius: 3px;
        `;

        const totalDamage = Object.values(stat.summary.damageDealt).reduce((a, b) => a + b, 0);
        const totalHPHeal = Object.values(stat.summary.hpHealed).reduce((a, b) => a + b, 0);
        const totalSPHeal = Object.values(stat.summary.spHealed).reduce((a, b) => a + b, 0);
        const totalMaxHPIncrease = stat.summary.maxHPIncreases;

        summaryDiv.innerHTML = `
            <p style="margin: 5px 0; font-weight: bold; color: #333;">📊 集計値</p>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px;">
                <div><strong>与ダメージ:</strong> <span style="color: #cc0000; font-weight: bold;">${totalDamage}</span></div>
                <div><strong>HP回復:</strong> <span style="color: #00aa00; font-weight: bold;">${totalHPHeal}</span></div>
                <div><strong>SP回復:</strong> <span style="color: #0066cc; font-weight: bold;">${totalSPHeal}</span></div>
                <div><strong>最大HP増加:</strong> <span style="color: #ff6600; font-weight: bold;">+${totalMaxHPIncrease}</span></div>
            </div>
            <div style="margin-top: 12px; font-size: 12px;">
                <p style="margin: 10px 0 4px; font-weight: bold; color: #333;">📌 受けたステータス変化</p>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <div><strong>最終ステータス変化:</strong><br>${formatStatusSummary(stat.summary.statusChangesReceived)}</div>
                    <div><strong>最終状態異常:</strong><br>${formatConditionMap(Object.keys(stat.summary.statusConditionsFinal).length > 0 ? stat.summary.statusConditionsFinal : stat.summary.statusConditionsReceived)}</div>
                    <div><strong>自己ステータス:</strong><br>${formatStatusMap(stat.summary.statusChangesReceivedSelf)}</div>
                    <div><strong>他者ステータス:</strong><br>${formatStatusMap(stat.summary.statusChangesReceivedOther)}</div>
                </div>
            </div>
        `;
        section.appendChild(summaryDiv);
        section.appendChild(createTurnTable(stat));

        return section;
    }

    function createTurnTable(stat) {
        const turnNums = Object.keys(stat.turns).map(n => parseInt(n, 10)).sort((a, b) => a - b);
        const table = document.createElement('table');
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            margin-top: 12px;
            font-size: 13px;
        `;

        const header = table.insertRow();
        const headers = ['ターン', '与ダメージ', 'HP回復', 'SP回復', ...trackedStatusFields, '状態異常', '最大HP増加'];
        headers.forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            th.style.cssText = 'padding: 8px; background: #eee; border: 1px solid #ccc; text-align: left;';
            header.appendChild(th);
        });

        if (turnNums.length === 0) {
            const row = table.insertRow();
            const cell = row.insertCell();
            cell.colSpan = headers.length;
            cell.textContent = 'ターン情報はありません';
            cell.style.cssText = 'padding: 10px; border: 1px solid #ccc; color: #666;';
            return table;
        }

        turnNums.forEach(turnNum => {
            const turnData = stat.turns[turnNum];
            const row = table.insertRow();
            const values = [
                turnNum,
                formatMap(turnData.damageDealt),
                formatMap(turnData.hpHealed),
                formatMap(turnData.spHealed),
                ...trackedStatusFields.map(field => getTurnStatusValue(turnData, field)),
                formatConditionMap(mergeConditionMaps(turnData)),
                turnData.maxHPIncreases || 0
            ];

            values.forEach(value => {
                const cell = row.insertCell();
                cell.style.cssText = 'padding: 8px; border: 1px solid #ccc; vertical-align: top;';
                cell.innerHTML = value;
            });
        });

        return table;
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
        ['statusConditionsSelf', 'statusConditionsOther'].forEach(key => {
            const map = turnData[key];
            if (map) {
                Object.entries(map).forEach(([condition, value]) => {
                    merged[condition] = (merged[condition] || 0) + value;
                });
            }
        });
        return merged;
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

})();
