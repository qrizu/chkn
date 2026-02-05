# chkn

ok (Chicken Race) på `chkn.sputnet.space` är ett spel där man kan utmana sina
vänner i antingen ett chicken run (vadslagning) eller en 5‑kamp som består av
följande spel:

1. Yatzy (finns redan som `ytzy.sputnet.space`)
2. Black Jack (ska byggas)
3. Frågesport (AI‑genererade frågor varje gång)
4. Musikquiz (gissa låtar)
5. Texas Hold’em (med ackumulerade poäng)

## 5‑kamp: flöde och regler

### 1) Yatzy
- Spelarna tar med sig sina poäng * 10 in i Black Jack.

### 2) Black Jack
- Varje spelare har 5 spelrutor.
- Man kan satsa mellan 10 och 100 per ruta.
- Det finns lika många rutor som på en vanlig Black Jack.

### Mellanspel: Roulette (mellan spel 2 och 3)
- Spelaren kan dubbla sina poäng genom att satsa på rött eller svart.
- Endast poängen som tjänats in i Black Jack får dubblas eller förloras här.

### 3) Frågesport
- AI‑genererade frågor varje gång.
- 20% lätta, 60% medel, 20% svåra.
- Poäng ges för rätt svar; snabbare svar ger mer poäng.
- Spelarna väljer kategori.
- 6 kategorier totalt.
- Round‑robin: 2 kategorier per spelare.

### Mellanspel: Tärningsbet (mellan spel 3 och 4)
- Slå första tärningen.
- Spelaren väljer hur mycket den vill betta på att nästa slag blir högre eller
  lägre än första.
- Vinst = insatsen dubblas, annars förloras insatsen.

### 4) Musikquiz
- Spela 5 random låtar.
- Snabbast och rätt svar ger högst poäng.

### 5) Texas Hold’em
- Spelarna startar med sina ackumulerade poäng.
- En runda avslutas när alla varit big och small blind 1 gång.
- Därefter dubblas blinds tills endast en spelare är kvar.
