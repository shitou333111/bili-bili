const fs = require('fs');
const data = JSON.parse(fs.readFileSync('.data/gift-catalog.json', 'utf8'));

// The gift catalog has two structures:
// 1. nameMap: { "id": { name, img } } - compact lookup
// 2. giftList: Array of full gift objects with price

// Find the full entries for our 5 gifts
const targetIds = [35777, 35778, 35779, 35780, 35600];

// Search in the array (first big array)
console.log('=== Full gift entries (from B站 giftConfig) ===');
for (const id of targetIds) {
  // The catalog data structure: first part is a map, then there's an array
  // Let's search recursively
  const found = searchGift(data, id);
  if (found) {
    console.log(`\nID: ${id}`);
    console.log(`  name: ${found.name}`);
    console.log(`  price (金瓜子): ${found.price}`);
    console.log(`  = ${found.price / 100} 电池`);
    console.log(`  coin_type: ${found.coin_type}`);
    console.log(`  effect: ${found.effect}`);
    console.log(`  img_basic: ${found.img_basic || found.img}`);
  }
}

function searchGift(obj, id) {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object') {
        if (item.id === id) return item;
        const found = searchGift(item, id);
        if (found) return found;
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    if (obj.id === id) return obj;
    for (const key of Object.keys(obj)) {
      const found = searchGift(obj[key], id);
      if (found) return found;
    }
  }
  return null;
}