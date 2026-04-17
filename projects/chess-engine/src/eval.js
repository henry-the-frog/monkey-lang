// eval.js — Position evaluation
// Returns score in centipawns from the perspective of the side to move

import { Board, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, iterBits, fileOf, rankOf, FILE_A, FILE_H, RANK_1, RANK_2, RANK_7, RANK_8, bishopAttacks, rookAttacks, queenAttacks, knightAttacks, popCount } from './board.js';

const PIECE_VALUES = [100, 320, 330, 500, 900, 0]; // P, N, B, R, Q, K

// Piece-square tables (from White's perspective, index = square a1=0 to h8=63)
// Flipped for Black
const PST = {
  [PAWN]: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  [KNIGHT]: [
   -50,-40,-30,-30,-30,-30,-40,-50,
   -40,-20,  0,  0,  0,  0,-20,-40,
   -30,  0, 10, 15, 15, 10,  0,-30,
   -30,  5, 15, 20, 20, 15,  5,-30,
   -30,  0, 15, 20, 20, 15,  0,-30,
   -30,  5, 10, 15, 15, 10,  5,-30,
   -40,-20,  0,  5,  5,  0,-20,-40,
   -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  [BISHOP]: [
   -20,-10,-10,-10,-10,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5, 10, 10,  5,  0,-10,
   -10,  5,  5, 10, 10,  5,  5,-10,
   -10,  0, 10, 10, 10, 10,  0,-10,
   -10, 10, 10, 10, 10, 10, 10,-10,
   -10,  5,  0,  0,  0,  0,  5,-10,
   -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  [ROOK]: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  [QUEEN]: [
   -20,-10,-10, -5, -5,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5,  5,  5,  5,  0,-10,
    -5,  0,  5,  5,  5,  5,  0, -5,
     0,  0,  5,  5,  5,  5,  0, -5,
   -10,  5,  5,  5,  5,  5,  0,-10,
   -10,  0,  5,  0,  0,  0,  0,-10,
   -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  [KING]: [
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -10,-20,-20,-20,-20,-20,-20,-10,
    20, 20,  0,  0,  0,  0, 20, 20,
    20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

// King endgame table
const KING_ENDGAME = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50,
];

function mirrorSquare(sq) {
  return (7 - rankOf(sq)) * 8 + fileOf(sq);
}

function isEndgame(board) {
  // Simplified: endgame if no queens or total material < threshold
  const whiteQueens = board.pieces[WHITE][QUEEN];
  const blackQueens = board.pieces[BLACK][QUEEN];
  return whiteQueens === 0n && blackQueens === 0n;
}

export function evaluate(board) {
  let score = 0;
  const endgame = isEndgame(board);

  for (let color = 0; color < 2; color++) {
    const sign = color === WHITE ? 1 : -1;

    for (let piece = 0; piece < 6; piece++) {
      for (const sq of iterBits(board.pieces[color][piece])) {
        // Material
        score += sign * PIECE_VALUES[piece];

        // Piece-square table
        const pstSq = color === WHITE ? sq : mirrorSquare(sq);
        const table = (piece === KING && endgame) ? KING_ENDGAME : PST[piece];
        score += sign * table[pstSq];
      }
    }
  }

  // Bishop pair bonus
  let whiteBishops = 0, blackBishops = 0;
  for (const _ of iterBits(board.pieces[WHITE][BISHOP])) whiteBishops++;
  for (const _ of iterBits(board.pieces[BLACK][BISHOP])) blackBishops++;
  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;

  // Mobility (count actual attack squares)
  const occ = board.occupied();
  let whiteMobility = 0, blackMobility = 0;

  // Knight mobility
  for (const sq of iterBits(board.pieces[WHITE][KNIGHT])) {
    const attacks = knightAttacks[sq] & ~board.colorBB(WHITE);
    whiteMobility += popCount(attacks);
  }
  for (const sq of iterBits(board.pieces[BLACK][KNIGHT])) {
    const attacks = knightAttacks[sq] & ~board.colorBB(BLACK);
    blackMobility += popCount(attacks);
  }

  // Bishop mobility
  for (const sq of iterBits(board.pieces[WHITE][BISHOP])) {
    const attacks = bishopAttacks(sq, occ) & ~board.colorBB(WHITE);
    whiteMobility += popCount(attacks);
  }
  for (const sq of iterBits(board.pieces[BLACK][BISHOP])) {
    const attacks = bishopAttacks(sq, occ) & ~board.colorBB(BLACK);
    blackMobility += popCount(attacks);
  }

  // Rook mobility
  for (const sq of iterBits(board.pieces[WHITE][ROOK])) {
    const attacks = rookAttacks(sq, occ) & ~board.colorBB(WHITE);
    whiteMobility += popCount(attacks);
  }
  for (const sq of iterBits(board.pieces[BLACK][ROOK])) {
    const attacks = rookAttacks(sq, occ) & ~board.colorBB(BLACK);
    blackMobility += popCount(attacks);
  }

  // Queen mobility (weighted less to avoid queen wandering)
  for (const sq of iterBits(board.pieces[WHITE][QUEEN])) {
    const attacks = queenAttacks(sq, occ) & ~board.colorBB(WHITE);
    whiteMobility += popCount(attacks) / 2;
  }
  for (const sq of iterBits(board.pieces[BLACK][QUEEN])) {
    const attacks = queenAttacks(sq, occ) & ~board.colorBB(BLACK);
    blackMobility += popCount(attacks) / 2;
  }

  score += (whiteMobility - blackMobility) * 3; // 3cp per mobility square

  // Pawn structure
  const whitePawns = board.pieces[WHITE][PAWN];
  const blackPawns = board.pieces[BLACK][PAWN];

  // Doubled pawns penalty
  for (let f = 0; f < 8; f++) {
    const fileMask = FILE_A << BigInt(f);
    const wPawnsOnFile = popCount(whitePawns & fileMask);
    const bPawnsOnFile = popCount(blackPawns & fileMask);
    if (wPawnsOnFile > 1) score -= (wPawnsOnFile - 1) * 15;
    if (bPawnsOnFile > 1) score += (bPawnsOnFile - 1) * 15;
  }

  // Isolated pawn penalty
  for (const sq of iterBits(whitePawns)) {
    const f = fileOf(sq);
    const adjacentFiles = (f > 0 ? FILE_A << BigInt(f - 1) : 0n) | (f < 7 ? FILE_A << BigInt(f + 1) : 0n);
    if ((whitePawns & adjacentFiles) === 0n) score -= 10;
  }
  for (const sq of iterBits(blackPawns)) {
    const f = fileOf(sq);
    const adjacentFiles = (f > 0 ? FILE_A << BigInt(f - 1) : 0n) | (f < 7 ? FILE_A << BigInt(f + 1) : 0n);
    if ((blackPawns & adjacentFiles) === 0n) score += 10;
  }

  // Passed pawn bonus (no opposing pawns ahead on same or adjacent files)
  for (const sq of iterBits(whitePawns)) {
    const f = fileOf(sq);
    const r = rankOf(sq);
    const adjacentFiles = (f > 0 ? FILE_A << BigInt(f - 1) : 0n) | (FILE_A << BigInt(f)) | (f < 7 ? FILE_A << BigInt(f + 1) : 0n);
    // Ranks ahead of white pawn (higher rank numbers)
    let aheadMask = 0n;
    for (let rank = r + 1; rank <= 7; rank++) aheadMask |= 0xFFn << BigInt(rank * 8);
    if ((blackPawns & adjacentFiles & aheadMask) === 0n) {
      // Bonus scales with rank advancement (rank 6 = about to promote)
      const rankBonus = [0, 10, 15, 25, 50, 100, 200][r] || 0;
      score += rankBonus;
    }
  }
  for (const sq of iterBits(blackPawns)) {
    const f = fileOf(sq);
    const r = rankOf(sq);
    const adjacentFiles = (f > 0 ? FILE_A << BigInt(f - 1) : 0n) | (FILE_A << BigInt(f)) | (f < 7 ? FILE_A << BigInt(f + 1) : 0n);
    let aheadMask = 0n;
    for (let rank = r - 1; rank >= 0; rank--) aheadMask |= 0xFFn << BigInt(rank * 8);
    if ((whitePawns & adjacentFiles & aheadMask) === 0n) {
      const rankBonus = [0, 200, 100, 50, 25, 15, 10][r] || 0;
      score -= rankBonus;
    }
  }

  // Rook on open/semi-open file
  for (const sq of iterBits(board.pieces[WHITE][ROOK])) {
    const fileMask = FILE_A << BigInt(fileOf(sq));
    if ((whitePawns & fileMask) === 0n) {
      score += (blackPawns & fileMask) === 0n ? 20 : 10; // open vs semi-open
    }
  }
  for (const sq of iterBits(board.pieces[BLACK][ROOK])) {
    const fileMask = FILE_A << BigInt(fileOf(sq));
    if ((blackPawns & fileMask) === 0n) {
      score -= (whitePawns & fileMask) === 0n ? 20 : 10;
    }
  }

  // King safety — pawn shield
  if (!endgame) {
    for (const sq of iterBits(board.pieces[WHITE][KING])) {
      const f = fileOf(sq);
      const r = rankOf(sq);
      if (r <= 1) { // King on back ranks
        let shield = 0;
        for (let df = -1; df <= 1; df++) {
          const sf = f + df;
          if (sf >= 0 && sf < 8) {
            const shieldMask = FILE_A << BigInt(sf);
            const frontRanks = RANK_2 | (RANK_2 << 8n);
            if ((whitePawns & shieldMask & frontRanks) !== 0n) shield++;
          }
        }
        score += shield * 10;
      }
    }
    for (const sq of iterBits(board.pieces[BLACK][KING])) {
      const f = fileOf(sq);
      const r = rankOf(sq);
      if (r >= 6) { // King on back ranks
        let shield = 0;
        for (let df = -1; df <= 1; df++) {
          const sf = f + df;
          if (sf >= 0 && sf < 8) {
            const shieldMask = FILE_A << BigInt(sf);
            const frontRanks = RANK_7 | (RANK_7 >> 8n);
            if ((blackPawns & shieldMask & frontRanks) !== 0n) shield++;
          }
        }
        score -= shield * 10;
      }
    }
  }

  // Return from side-to-move perspective
  return board.side === WHITE ? score : -score;
}
