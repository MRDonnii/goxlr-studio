// Microphones the presets know (micpresets.js). `features` describe how the mic deviates from a
// flat response as it is normally used for speech, from the maker's frequency-response graph:
//   lowcut    roll-off below freq (db ≈ level at freq/2)
//   lowshelf  / highshelf  broad shelf at freq (dynamic close-up mics: their proximity bass)
//   peak      bump/dip at freq (q: 0.7 broad … 2 narrow)
//   highcut   roll-off above freq (db ≈ level an octave above)
// sensitivity_dbv: dBV/Pa at 1 kHz. type: 'dynamic' or 'condenser' (needs +48 V).
export const MIC_MODELS = [
  {
    id: 'rode-nt1', name: 'Røde NT1 (5. generation)', brand: 'Røde', type: 'condenser', sensitivity_dbv: -29,
    features: [{ kind: 'peak', freq: 5500, db: 2, q: 0.9 }],
  },
  {
    id: 'fifine-k688', name: 'Fifine K688', brand: 'Fifine', type: 'dynamic', sensitivity_dbv: -50,
    features: [{ kind: 'lowshelf', freq: 150, db: 4 }, { kind: 'peak', freq: 4500, db: 2, q: 1 }, { kind: 'highcut', freq: 10000, db: -6 }],
  },
];
