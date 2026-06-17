// --- Native Binary FIT Stream Interpreter ---
// Tracks and safely extracts power fields from continuous stream loops (Global Msg: 20, Field: 7)
function parseFitPowerStream(uint8Array) {
    const dataView = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
    
    // Validate FIT signature: ".FIT" at bytes 8-11
    if (uint8Array.length < 12 || 
        uint8Array[8] !== 0x2e || uint8Array[9] !== 0x46 || 
        uint8Array[10] !== 0x49 || uint8Array[11] !== 0x54) {
        return [];
    }

    const headerLength = uint8Array[0];
    let pos = headerLength;
    const powerStream = [];
    const localDefinitions = {};

    while (pos < uint8Array.length - 2) {
        const recordHeader = uint8Array[pos];
        pos += 1;

        if ((recordHeader & 0x80) === 0x80) {
            // Compressed Timestamp Header
            const localMsgType = (recordHeader & 0x60) >> 5;
            const def = localDefinitions[localMsgType];
            if (def) {
                parseDataRecord(def);
            } else {
                break; // Cannot proceed without definition
            }
        } else if ((recordHeader & 0x40) === 0x40) {
            // Definition Record
            pos += 1; // reserved
            const architecture = uint8Array[pos]; 
            const isLittleEndian = architecture === 0;
            pos += 1;
            
            const globalMsgNum = dataView.getUint16(pos, isLittleEndian);
            pos += 2;
            
            const numFields = uint8Array[pos];
            pos += 1;
            
            const fields = [];
            let totalLength = 0;
            for (let i = 0; i < numFields; i++) {
                const fieldNum = uint8Array[pos];
                const size = uint8Array[pos + 1];
                const baseType = uint8Array[pos + 2];
                fields.push({ fieldNum, size, baseType });
                totalLength += size;
                pos += 3;
            }
            
            if ((recordHeader & 0x20) === 0x20) { // bypass developer attributes
                const numDevFields = uint8Array[pos];
                pos += 1 + (numDevFields * 3);
            }

            const localMsgType = recordHeader & 0x0F;
            localDefinitions[localMsgType] = { globalMsgNum, fields, totalLength, isLittleEndian };
        } else {
            // Normal Data Record
            const localMsgType = recordHeader & 0x0F;
            const def = localDefinitions[localMsgType];
            if (def) {
                parseDataRecord(def);
            } else {
                break; // Cannot proceed without definition
            }
        }
    }

    function parseDataRecord(def) {
        if (def.globalMsgNum === 20) { // Telemetry Record Row
            let fieldPos = pos;
            let recordPower = null;
            
            for (const field of def.fields) {
                if (field.fieldNum === 7) { // Power (Watts) Mapping Field
                    if (field.size === 2) {
                        recordPower = dataView.getUint16(fieldPos, def.isLittleEndian);
                    }
                }
                fieldPos += field.size;
            }
            if (recordPower !== null && recordPower !== 0xFFFF) {
                powerStream.push(recordPower);
            }
        }
        pos += def.totalLength;
    }

    return powerStream;
}

/**
 * Calculates the Mean Maximal Power for a set of durations from an array of power data.
 * @param {Array} powerData - Array of power samples (one per second)
 * @param {Array} durations - Array of duration objects {seconds, label}
 * @returns {Array} - Array of max averages for each duration
 */
function calculatePowerCurve(powerData, durations) {
    return durations.map(duration => {
        const windowSize = duration.seconds;
        if (powerData.length < windowSize) return 0;

        let currentSum = 0;
        for (let i = 0; i < windowSize; i++) {
            currentSum += powerData[i];
        }
        let maxMovingAvg = currentSum / windowSize;

        for (let i = windowSize; i < powerData.length; i++) {
            currentSum = currentSum - powerData[i - windowSize] + powerData[i];
            const avg = currentSum / windowSize;
            if (avg > maxMovingAvg) maxMovingAvg = avg;
        }
        return maxMovingAvg;
    });
}

/**
 * Helper to calculate percentile values from an array
 */
function getPercentile(data, percentile) {
    if (data.length === 0) return 0;
    const sorted = [...data].sort((a, b) => a - b);
    if (percentile >= 1) return sorted[sorted.length - 1];
    const index = (sorted.length - 1) * percentile;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (upper >= sorted.length) return sorted[lower];
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}