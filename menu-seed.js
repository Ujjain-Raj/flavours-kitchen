// Seed menu for Flavours Kitchen, taken from the handwritten menu sheet.
// The sheet lists categories only (no dish names or prices), so dishes and prices
// below are PLACEHOLDERS. Edit them in Admin > Menu.
// v = veg, n = non-veg, e = egg
const categories = [
  { id: 'tiffins', name: 'Tiffins', station: 'tiffin' },
  { id: 'meals', name: 'Meals', station: 'main' },
  { id: 'biryanis', name: 'Biryanis', station: 'main' },
  { id: 'pulaos', name: 'Pulaos', station: 'main' },
  { id: 'juices', name: 'Juices', station: 'beverage' },
  { id: 'chat', name: 'Chat', station: 'snack' },
  { id: 'shakes', name: 'Protein Shakes', station: 'beverage' },
  { id: 'snacks', name: 'Snacks', station: 'snack' },
  { id: 'chai', name: 'Irani Chai', station: 'beverage' },
  { id: 'chinese', name: 'Chinese', station: 'chinese' },
  { id: 'fish', name: 'Fish & Prawns Fry & Curry', station: 'fry' },
  { id: 'curry', name: 'Curry Point', station: 'main' },
];

const raw = {
  tiffins: [
    ['Idli (3 pcs)', 40, 'v'], ['Plain Dosa', 50, 'v'], ['Masala Dosa', 70, 'v'], ['Pesarattu', 60, 'v'],
    ['Poori (3 pcs)', 60, 'v'], ['Medu Vada (2 pcs)', 45, 'v'], ['Upma', 40, 'v'],
    ['Egg Dosa', 70, 'e'], ['Chicken Keema Dosa', 120, 'n'], ['Egg Poori Curry', 80, 'e'],
  ],
  meals: [
    ['Veg Meals', 110, 'v'], ['Mini Meals', 80, 'v'], ['Special Veg Meals', 150, 'v'],
    ['Chicken Meals', 160, 'n'], ['Fish Meals', 180, 'n'], ['Mutton Meals', 220, 'n'], ['Egg Meals', 130, 'e'],
  ],
  biryanis: [
    ['Veg Biryani', 140, 'v'], ['Paneer Biryani', 180, 'v'],
    ['Chicken Dum Biryani', 200, 'n'], ['Mutton Biryani', 280, 'n'], ['Prawns Biryani', 280, 'n'], ['Egg Biryani', 150, 'e'],
  ],
  pulaos: [
    ['Veg Pulao', 120, 'v'], ['Paneer Pulao', 160, 'v'], ['Jeera Rice', 90, 'v'],
    ['Chicken Pulao', 170, 'n'], ['Mutton Pulao', 240, 'n'],
  ],
  juices: [
    ['Watermelon Juice', 60, 'v'], ['Mosambi Juice', 70, 'v'], ['Pineapple Juice', 70, 'v'],
    ['Mango Juice', 80, 'v'], ['Sugarcane Juice', 50, 'v'], ['Fresh Lime Soda', 50, 'v'],
  ],
  chat: [
    ['Pani Puri', 40, 'v'], ['Bhel Puri', 50, 'v'], ['Samosa Chat', 60, 'v'], ['Dahi Puri', 60, 'v'], ['Papdi Chat', 60, 'v'],
  ],
  shakes: [
    ['Banana Protein Shake', 120, 'v'], ['Chocolate Protein Shake', 140, 'v'],
    ['Dry Fruit Protein Shake', 160, 'v'], ['Peanut Butter Shake', 150, 'v'],
  ],
  snacks: [
    ['Veg Puff', 25, 'v'], ['Samosa (2 pcs)', 30, 'v'], ['Mirchi Bajji (4 pcs)', 40, 'v'], ['Onion Pakoda', 50, 'v'],
    ['Egg Puff', 30, 'e'], ['Chicken Puff', 40, 'n'], ['Chicken Samosa (2 pcs)', 50, 'n'],
  ],
  chai: [
    ['Irani Chai', 20, 'v'], ['Special Chai', 25, 'v'], ['Lemon Tea', 20, 'v'], ['Osmania Biscuits (4)', 20, 'v'], ['Bun Maska', 40, 'v'],
  ],
  chinese: [
    ['Veg Fried Rice', 120, 'v'], ['Veg Noodles', 120, 'v'], ['Gobi Manchurian', 130, 'v'], ['Paneer Chilli', 170, 'v'],
    ['Chicken Fried Rice', 150, 'n'], ['Chicken Noodles', 150, 'n'], ['Chilli Chicken', 180, 'n'], ['Egg Fried Rice', 130, 'e'],
  ],
  fish: [
    ['Fish Fry', 220, 'n'], ['Fish Curry', 220, 'n'], ['Apollo Fish', 260, 'n'],
    ['Prawns Fry', 300, 'n'], ['Prawns Curry', 300, 'n'], ['Fish Pulusu', 220, 'n'],
  ],
  curry: [
    ['Paneer Butter Masala', 190, 'v'], ['Dal Tadka', 120, 'v'], ['Mixed Veg Curry', 130, 'v'], ['Palak Paneer', 180, 'v'],
    ['Butter Chicken', 230, 'n'], ['Chicken Curry', 200, 'n'], ['Mutton Curry', 280, 'n'], ['Egg Curry', 120, 'e'],
    ['Tandoori Roti', 20, 'v'], ['Butter Naan', 40, 'v'], ['Plain Rice', 60, 'v'],
  ],
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const items = [];
for (const c of categories) {
  for (const [name, price, t] of raw[c.id]) {
    items.push({
      id: slug(c.id + '-' + name), name, price, categoryId: c.id,
      diet: t === 'v' ? 'veg' : t === 'e' ? 'egg' : 'nonveg', available: true, desc: '',
    });
  }
}
module.exports = { categories, items };
