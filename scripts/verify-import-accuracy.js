const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, '..', 'pamplay-frontend', 'app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Simple regex extraction of functions from app.js to ensure we test the actual file code
function extractFunction(funcName, fileContent) {
    const regex = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    const match = regex.exec(fileContent);
    if (!match) {
        throw new Error(`Could not find function ${funcName} in app.js`);
    }
    
    // Parse the curly brace block
    let braceCount = 1;
    let index = regex.lastIndex;
    while (braceCount > 0 && index < fileContent.length) {
        const char = fileContent[index];
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        index++;
    }
    
    const funcBody = fileContent.substring(match.index, index);
    return funcBody;
}

// Extract the functions
console.log('Extracting functions from app.js...');
const cleanMetadataStringCode = extractFunction('cleanMetadataString', appJsContent);
const normalizeSearchTextCode = extractFunction('normalizeSearchText', appJsContent);
const tokenSetCode = extractFunction('tokenSet', appJsContent);
const scoreTokenOverlapCode = extractFunction('scoreTokenOverlap', appJsContent);
const computeCuratedMatchScoreCode = extractFunction('computeCuratedMatchScore', appJsContent);

// Run in isolated VM context to avoid scope collisions
const vm = require('vm');
const testContext = {};
vm.createContext(testContext);
vm.runInContext(`
    ${cleanMetadataStringCode}
    ${normalizeSearchTextCode}
    ${tokenSetCode}
    ${scoreTokenOverlapCode}
    ${computeCuratedMatchScoreCode}
`, testContext);

const { cleanMetadataString, normalizeSearchText, computeCuratedMatchScore } = testContext;

// Test Suite
let passes = 0;
let fails = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`[\u001b[32mPASS\u001b[0m] ${message}`);
        passes++;
    } else {
        console.error(`[\u001b[31mFAIL\u001b[0m] ${message}`);
        fails++;
    }
}

console.log('\n--- Running Metadata Cleaner Tests ---');
const clean1 = cleanMetadataString('Chura Ke Dil Mera (From "Main Khiladi Tu Anari") [Original Sound Recording]');
assert(clean1 === 'Chura Ke Dil Mera', `Expected 'Chura Ke Dil Mera', got '${clean1}'`);

const clean2 = cleanMetadataString('Zara Zara [Remix] - Official Audio');
assert(clean2 === 'Zara Zara', `Expected 'Zara Zara', got '${clean2}'`);

const clean3 = cleanMetadataString('Main Khiladi Tu Anari (feat. Kumar Sanu) [Official Video]');
assert(clean3 === 'Main Khiladi Tu Anari', `Expected 'Main Khiladi Tu Anari', got '${clean3}'`);

const clean4 = cleanMetadataString('Tum Hi Ho - Lyrical Mix Version');
assert(clean4 === 'Tum Hi Ho', `Expected 'Tum Hi Ho', got '${clean4}'`);


console.log('\n--- Running Match Scorer Spaceless Tests ---');
// Spaceless match: identical title after removing spaces
const track1 = { name: 'Churake Dil Mera', artist: 'Kumar Sanu' };
const item1 = { name: 'Chura Ke Dil Mera', artist: 'Kumar Sanu' };
const score1 = computeCuratedMatchScore(track1, item1);
assert(score1 === 1.0, `Spaceless exact title and artist should match 1.0. Got: ${score1}`);

// Spaceless substring match
const track2 = { name: 'Tumhiho', artist: 'Arijit Singh' };
const item2 = { name: 'Tum Hi Ho (From "Aashiqui 2")', artist: 'Arijit Singh' };
const score2 = computeCuratedMatchScore(track2, { name: cleanMetadataString(item2.name), artist: item2.artist });
assert(score2 >= 0.88, `Spaceless substring title and artist match should be high (>= 0.88). Got: ${score2}`);

// Artist match weighting (title match but different artist)
const track3 = { name: 'Chura Ke Dil Mera', artist: 'Alka Yagnik' };
const item3 = { name: 'Chura Ke Dil Mera', artist: 'Kumar Sanu' };
const score3 = computeCuratedMatchScore(track3, item3);
assert(score3 < 0.80, `Same title but different artist should score lower. Got: ${score3}`);

console.log(`\nVerification complete. Passes: ${passes}, Fails: ${fails}`);
if (fails > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
