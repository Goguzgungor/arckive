// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Just real enough for the worker's insight context: the token logs ERC-20
// Transfers and answers symbol()/decimals(); the pool logs Uniswap v3's Swap
// event and answers factory() with Aerodrome's factory, so a swap through it
// reads as a swap on Aerodrome.
contract Token {
    event Transfer(address indexed from, address indexed to, uint256 value);

    string public symbol = "TKN";
    uint8 public decimals = 6;

    function transfer(address to, uint256 value) external returns (bool) {
        emit Transfer(msg.sender, to, value);
        return true;
    }
}

contract Pool {
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    address public constant factory = 0xb89Df768aF2CFE637ceB352c587Fe8edAf491d03;

    function swap(Token token, address to, uint256 value) external {
        token.transfer(to, value);
        emit Swap(msg.sender, to, 0, 0, 0, 0, 0);
    }
}
