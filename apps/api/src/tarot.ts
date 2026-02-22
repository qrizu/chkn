export type TarotCard = {
  number: number;
  name: string;
  imageUrl: string;
  summary: string;
  upright: string;
  reversed: string;
  moreInfoUrl: string;
};

export type TarotOrientation = "upright" | "reversed";

const deckBaseUrl = (process.env.TAROT_DECK_BASE_URL || "https://clubsfar.org/tarot").replace(/\/$/, "");
const isSwedishLocale = (locale = "en-US") => locale.toLowerCase().startsWith("sv");

type TarotCardTranslation = Pick<TarotCard, "name" | "summary" | "upright" | "reversed">;

const majorArcana: Array<Omit<TarotCard, "imageUrl"> & { imagePath: string }> = [
  { number: 0, name: "The Fool", imagePath: "img/deck/00_Fool.webp", summary: "The Fool points to new beginnings, openness, and trust in life’s unfolding path.", upright: "Beginnings, innocence, spontaneity, a free spirit.", reversed: "Holding back, recklessness, risk-taking.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/fool/" },
  { number: 1, name: "The Magician", imagePath: "img/deck/01_Magician.webp", summary: "The Magician highlights personal power, skills, and focused intention to make things happen.", upright: "Manifestation, resourcefulness, power, inspired action.", reversed: "Manipulation, poor planning, untapped talents.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/magician/" },
  { number: 2, name: "The High Priestess", imagePath: "img/deck/02_High_Priestess.webp", summary: "The High Priestess asks you to trust intuition, stillness, and what is sensed beneath the surface.", upright: "Intuition, sacred knowledge, divine feminine, the subconscious mind.", reversed: "Secrets, disconnected from intuition, withdrawal and silence.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/high-priestess/" },
  { number: 3, name: "The Empress", imagePath: "img/deck/03_Empress.webp", summary: "The Empress symbolizes nurture, creativity, beauty, and growth through care.", upright: "Femininity, beauty, nature, nurturing, abundance.", reversed: "Creative block, dependence on others.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/empress/" },
  { number: 4, name: "The Emperor", imagePath: "img/deck/04_Emperor.webp", summary: "The Emperor is structure, leadership, boundaries, and responsible authority.", upright: "Authority, establishment, structure, a father figure.", reversed: "Domination, excessive control, lack of discipline, inflexibility.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/emperor/" },
  { number: 5, name: "The Hierophant", imagePath: "img/deck/05_Hierophant.webp", summary: "The Hierophant points to tradition, guidance, and learning within established systems.", upright: "Spiritual wisdom, religious beliefs, conformity, tradition, institutions.", reversed: "Personal beliefs, freedom, challenging the status quo.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/hierophant/" },
  { number: 6, name: "The Lovers", imagePath: "img/deck/06_Lovers.webp", summary: "The Lovers is about connection, meaningful choice, and alignment with core values.", upright: "Love, harmony, relationships, values alignment, choices.", reversed: "Self-love, disharmony, imbalance, misalignment of values.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/lovers/" },
  { number: 7, name: "The Chariot", imagePath: "img/deck/07_Chariot.webp", summary: "The Chariot signals momentum, control, and victory through discipline and direction.", upright: "Control, willpower, success, action, determination.", reversed: "Self-discipline, opposition, lack of direction.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/chariot/" },
  { number: 8, name: "Strength", imagePath: "img/deck/08_Strength.webp", summary: "Strength reflects inner courage, patience, and steady heart-led power.", upright: "Strength, courage, persuasion, influence, compassion.", reversed: "Inner strength, self-doubt, low energy, raw emotion.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/strength/" },
  { number: 9, name: "The Hermit", imagePath: "img/deck/09_Hermit.webp", summary: "The Hermit invites reflection, solitude, and wisdom found within.", upright: "Soul-searching, introspection, being alone, inner guidance.", reversed: "Isolation, loneliness, withdrawal.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/hermit/" },
  { number: 10, name: "Wheel of Fortune", imagePath: "img/deck/10_Wheel_of_Fortune.webp", summary: "Wheel of Fortune marks turning points, cycles, and the movement of fate.", upright: "Good luck, karma, life cycles, destiny, a turning point.", reversed: "Bad luck, resistance to change, breaking cycles.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/wheel-of-fortune/" },
  { number: 11, name: "Justice", imagePath: "img/deck/11_Justice.webp", summary: "Justice asks for truth, fairness, and accountability in decisions.", upright: "Justice, fairness, truth, cause and effect, law.", reversed: "Unfairness, lack of accountability, dishonesty.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/justice/" },
  { number: 12, name: "The Hanged Man", imagePath: "img/deck/12_Hanged_Man.webp", summary: "The Hanged Man is a pause that opens fresh perspective through surrender.", upright: "Pause, surrender, letting go, new perspectives.", reversed: "Delays, resistance, stalling, indecision.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/hanged-man/" },
  { number: 13, name: "Death", imagePath: "img/deck/13_Death.webp", summary: "Death signifies endings, transition, and transformation into the new.", upright: "Endings, change, transformation, transition.", reversed: "Resistance to change, personal transformation, inner purging.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/death/" },
  { number: 14, name: "Temperance", imagePath: "img/deck/14_Temperance.webp", summary: "Temperance brings balance, moderation, and integration.", upright: "Balance, moderation, patience, purpose.", reversed: "Imbalance, excess, self-healing, re-alignment.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/temperance/" },
  { number: 15, name: "The Devil", imagePath: "img/deck/15_Devil.webp", summary: "The Devil reveals attachment, shadow patterns, and limiting bonds.", upright: "Shadow self, attachment, addiction, restriction, sexuality.", reversed: "Releasing limiting beliefs, exploring dark thoughts, detachment.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/devil/" },
  { number: 16, name: "The Tower", imagePath: "img/deck/16_Tower.webp", summary: "The Tower is sudden upheaval that clears unstable structures.", upright: "Sudden change, upheaval, chaos, revelation, awakening.", reversed: "Personal transformation, fear of change, averting disaster.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/tower/" },
  { number: 17, name: "The Star", imagePath: "img/deck/17_Star.webp", summary: "The Star restores hope, faith, and spiritual renewal.", upright: "Hope, faith, purpose, renewal, spirituality.", reversed: "Lack of faith, despair, self-trust, disconnection.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/star/" },
  { number: 18, name: "The Moon", imagePath: "img/deck/18_Moon.webp", summary: "The Moon signals uncertainty, intuition, and what is hidden in the subconscious.", upright: "Illusion, fear, anxiety, subconscious, intuition.", reversed: "Release of fear, repressed emotion, inner confusion.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/moon/" },
  { number: 19, name: "The Sun", imagePath: "img/deck/19_Sun.webp", summary: "The Sun is joy, vitality, warmth, and open success.", upright: "Positivity, fun, warmth, success, vitality.", reversed: "Inner child, feeling down, overly optimistic.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/sun/" },
  { number: 20, name: "Judgement", imagePath: "img/deck/20_Judgement.webp", summary: "Judgement is awakening, evaluation, and answering your inner calling.", upright: "Judgement, rebirth, inner calling, absolution.", reversed: "Self-doubt, inner critic, ignoring the call.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/judgement/" },
  { number: 21, name: "The World", imagePath: "img/deck/21_World.webp", summary: "The World marks completion, integration, and fulfillment before a new cycle.", upright: "Completion, integration, accomplishment, travel.", reversed: "Seeking personal closure, short-cuts, delays.", moreInfoUrl: "https://www.biddytarot.com/tarot-card-meanings/major-arcana/world/" },
];

const majorArcanaSv: Record<number, TarotCardTranslation> = {
  0: {
    name: "Narren",
    summary: "Narren pekar mot nya början, öppenhet och tillit till livets väg.",
    upright: "Början, oskuld, spontanitet, fri själ.",
    reversed: "Håller tillbaka, vårdslöshet, risktagande.",
  },
  1: {
    name: "Magikern",
    summary: "Magikern lyfter personlig kraft, skicklighet och fokuserad intention.",
    upright: "Manifestation, resursfullhet, kraft, inspirerad handling.",
    reversed: "Manipulation, svag planering, outnyttjad talang.",
  },
  2: {
    name: "Översteprästinnan",
    summary: "Översteprästinnan ber dig lita på intuition, stillhet och underströmmar.",
    upright: "Intuition, helig kunskap, gudomlig femininitet, undermedvetet.",
    reversed: "Hemligheter, bortkopplad intuition, tillbakadragande och tystnad.",
  },
  3: {
    name: "Kejsarinnan",
    summary: "Kejsarinnan symboliserar omsorg, kreativitet, skönhet och växande.",
    upright: "Femininitet, skönhet, natur, omvårdnad, överflöd.",
    reversed: "Kreativ blockering, beroende av andra.",
  },
  4: {
    name: "Kejsaren",
    summary: "Kejsaren står för struktur, ledarskap, gränser och ansvar.",
    upright: "Auktoritet, etablering, struktur, fadersfigur.",
    reversed: "Dominans, överkontroll, brist på disciplin, stelhet.",
  },
  5: {
    name: "Hierofanten",
    summary: "Hierofanten pekar på tradition, vägledning och lärande inom system.",
    upright: "Andlig visdom, tro, konformitet, tradition, institutioner.",
    reversed: "Personlig tro, frihet, ifrågasätta status quo.",
  },
  6: {
    name: "De älskande",
    summary: "De älskande handlar om kontakt, meningsfulla val och värdegrund.",
    upright: "Kärlek, harmoni, relationer, värdealignment, val.",
    reversed: "Självkärlek, disharmoni, obalans, värdekonflikt.",
  },
  7: {
    name: "Vagnen",
    summary: "Vagnen signalerar momentum, kontroll och seger genom disciplin.",
    upright: "Kontroll, viljestyrka, framgång, handling, beslutsamhet.",
    reversed: "Självdisciplin, motstånd, brist på riktning.",
  },
  8: {
    name: "Styrka",
    summary: "Styrka speglar inre mod, tålamod och hjärtledd kraft.",
    upright: "Styrka, mod, påverkan, inflytande, medkänsla.",
    reversed: "Inre styrka, självtvivel, låg energi, råa känslor.",
  },
  9: {
    name: "Eremiten",
    summary: "Eremiten bjuder in till reflektion, ensamhet och inre visdom.",
    upright: "Självrannsakan, introspektion, ensamhet, inre vägledning.",
    reversed: "Isolering, ensamhet, tillbakadragande.",
  },
  10: {
    name: "Lyckohjulet",
    summary: "Lyckohjulet markerar vändpunkter, cykler och ödesrörelse.",
    upright: "Tur, karma, livscykler, öde, vändpunkt.",
    reversed: "Oturskänsla, motstånd mot förändring, bryta mönster.",
  },
  11: {
    name: "Rättvisa",
    summary: "Rättvisa kräver sanning, balans och ansvar i beslut.",
    upright: "Rättvisa, balans, sanning, orsak och verkan, lag.",
    reversed: "Orättvisa, brist på ansvar, oärlighet.",
  },
  12: {
    name: "Den hängde",
    summary: "Den hängde är en paus som öppnar nya perspektiv.",
    upright: "Paus, överlämnande, släppa taget, nya perspektiv.",
    reversed: "Fördröjningar, motstånd, stillastående, obeslutsamhet.",
  },
  13: {
    name: "Döden",
    summary: "Döden betyder avslut, övergång och transformation.",
    upright: "Avslut, förändring, transformation, övergång.",
    reversed: "Motstånd mot förändring, inre rening, personlig omvandling.",
  },
  14: {
    name: "Måttfullhet",
    summary: "Måttfullhet för in balans, moderation och integration.",
    upright: "Balans, moderation, tålamod, syfte.",
    reversed: "Obalans, överdrift, självläkning, omkalibrering.",
  },
  15: {
    name: "Djävulen",
    summary: "Djävulen visar bindningar, skuggmönster och begränsningar.",
    upright: "Skuggsida, bindning, beroende, restriktion, sexualitet.",
    reversed: "Frigörelse från begränsningar, möta mörka tankar, distans.",
  },
  16: {
    name: "Tornet",
    summary: "Tornet är plötslig omvälvning som river instabila strukturer.",
    upright: "Plötslig förändring, omvälvning, kaos, uppvaknande.",
    reversed: "Inre transformation, rädsla för förändring, avvärjd kris.",
  },
  17: {
    name: "Stjärnan",
    summary: "Stjärnan återställer hopp, tro och andlig förnyelse.",
    upright: "Hopp, tro, syfte, förnyelse, andlighet.",
    reversed: "Brist på tro, förtvivlan, självtillit, frånkoppling.",
  },
  18: {
    name: "Månen",
    summary: "Månen signalerar osäkerhet, intuition och det dolda.",
    upright: "Illusion, rädsla, oro, undermedvetet, intuition.",
    reversed: "Släpper rädsla, undertryckta känslor, inre förvirring.",
  },
  19: {
    name: "Solen",
    summary: "Solen står för glädje, vitalitet, värme och öppen framgång.",
    upright: "Positivitet, glädje, värme, framgång, livskraft.",
    reversed: "Inre barn, nedstämdhet, överoptimism.",
  },
  20: {
    name: "Domen",
    summary: "Domen betyder uppvaknande, utvärdering och inre kallelse.",
    upright: "Dom, återfödelse, inre kallelse, försoning.",
    reversed: "Självtvivel, inre kritiker, ignorera kallelsen.",
  },
  21: {
    name: "Världen",
    summary: "Världen markerar fullbordan, integration och uppfyllelse.",
    upright: "Fullbordan, integration, prestation, resa.",
    reversed: "Söker avslut, genvägar, fördröjningar.",
  },
};

const majorArcanaCanonical: TarotCard[] = majorArcana.map((card) => ({
  ...card,
  imageUrl: `${deckBaseUrl}/${card.imagePath}`,
}));

export const tarotMajorArcana: TarotCard[] = majorArcanaCanonical;

export const localizeTarotCard = (card: TarotCard, locale = "en-US"): TarotCard => {
  if (!isSwedishLocale(locale)) return card;
  const sv = majorArcanaSv[card.number];
  if (!sv) return card;
  return {
    ...card,
    ...sv,
  };
};

export const getTarotMajorArcana = (locale = "en-US"): TarotCard[] =>
  majorArcanaCanonical.map((card) => localizeTarotCard(card, locale));

export const getTarotCardByNumber = (cardNumber: number, locale = "en-US"): TarotCard | null => {
  const card = majorArcanaCanonical.find((entry) => entry.number === cardNumber);
  if (!card) return null;
  return localizeTarotCard(card, locale);
};

export const drawDailyTarotCard = (): { card: TarotCard; orientation: TarotOrientation } => {
  const idx = Math.floor(Math.random() * majorArcanaCanonical.length);
  const card = majorArcanaCanonical[idx];
  const orientation: TarotOrientation = Math.random() < 0.5 ? "upright" : "reversed";
  return { card, orientation };
};
