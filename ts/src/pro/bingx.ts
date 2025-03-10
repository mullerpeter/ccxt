
//  ---------------------------------------------------------------------------

import bingxRest from '../bingx.js';
import { BadRequest, NetworkError } from '../base/errors.js';
import { ArrayCache, ArrayCacheByTimestamp, ArrayCacheBySymbolById } from '../base/ws/Cache.js';
import type { Int, OHLCV, Str, OrderBook, Order, Trade, Balances } from '../base/types.js';
import Client from '../base/ws/Client.js';
import Precise from '../base/Precise.js';

//  ---------------------------------------------------------------------------

export default class bingx extends bingxRest {
    describe () {
        return this.deepExtend (super.describe (), {
            'has': {
                'ws': true,
                'watchTrades': true,
                'watchOrderBook': true,
                'watchOHLCV': true,
                'watchOrders': true,
                'watchMyTrades': true,
                'watchTicker': false,
                'watchTickers': false,
                'watchBalance': true,
            },
            'urls': {
                'api': {
                    'ws': {
                        'spot': 'wss://open-api-ws.bingx.com/market',
                        'swap': 'wss://open-api-swap.bingx.com/swap-market',
                    },
                },
            },
            'options': {
                'listenKeyRefreshRate': 3540000, // 1 hour (59 mins so we have 1min to renew the token)
                'ws': {
                    'gunzip': true,
                },
                'swap': {
                    'timeframes': {
                        '1m': '1m',
                        '3m': '3m',
                        '5m': '5m',
                        '15m': '15m',
                        '30m': '30m',
                        '1h': '1h',
                        '2h': '2h',
                        '4h': '4h',
                        '6h': '6h',
                        '12h': '12h',
                        '1d': '1d',
                        '3d': '3d',
                        '1w': '1w',
                        '1M': '1M',
                    },
                },
                'spot': {
                    'timeframes': {
                        '1m': '1min',
                        '5m': '5min',
                        '15m': '15min',
                        '30m': '30min',
                        '1h': '60min',
                        '1d': '1day',
                    },
                },
                'watchBalance': {
                    'fetchBalanceSnapshot': true, // needed to be true to keep track of used and free balance
                    'awaitBalanceSnapshot': false, // whether to wait for the balance snapshot before providing updates
                },
            },
            'streaming': {
                'keepAlive': 1800000, // 30 minutes
            },
        });
    }

    async watchTrades (symbol: string, since: Int = undefined, limit: Int = undefined, params = {}): Promise<Trade[]> {
        /**
         * @method
         * @name bingx#watchTrades
         * @description watches information on multiple trades made in a market
         * @see https://bingx-api.github.io/docs/#/spot/socket/market.html#Subscribe%20to%20tick-by-tick
         * @see https://bingx-api.github.io/docs/#/swapV2/socket/market.html#Subscribe%20the%20Latest%20Trade%20Detail
         * @param {string} symbol unified market symbol of the market orders were made in
         * @param {int} [since] the earliest time in ms to fetch orders for
         * @param {int} [limit] the maximum number of order structures to retrieve
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object[]} a list of [order structures]{@link https://docs.ccxt.com/#/?id=order-structure
         */
        await this.loadMarkets ();
        const market = this.market (symbol);
        const [ marketType, query ] = this.handleMarketTypeAndParams ('watchTrades', market, params);
        const url = this.safeValue (this.urls['api']['ws'], marketType);
        if (url === undefined) {
            throw new BadRequest (this.id + ' watchTrades is not supported for ' + marketType + ' markets.');
        }
        const messageHash = market['id'] + '@trade';
        const uuid = this.uuid ();
        const request = {
            'id': uuid,
            'dataType': messageHash,
        };
        if (marketType === 'swap') {
            request['reqType'] = 'sub';
        }
        const trades = await this.watch (url, messageHash, this.extend (request, query), messageHash);
        if (this.newUpdates) {
            limit = trades.getLimit (symbol, limit);
        }
        return this.filterBySinceLimit (trades, since, limit, 'timestamp', true);
    }

    handleTrades (client: Client, message) {
        //
        // spot
        // first snapshot
        //
        //    {
        //      "id": "d83b78ce-98be-4dc2-b847-12fe471b5bc5",
        //      "code": 0,
        //      "msg": "SUCCESS",
        //      "timestamp": 1690214699854
        //    }
        //
        // subsequent updates
        //
        //     {
        //         "code": 0,
        //         "data": {
        //           "E": 1690214529432,
        //           "T": 1690214529386,
        //           "e": "trade",
        //           "m": true,
        //           "p": "29110.19",
        //           "q": "0.1868",
        //           "s": "BTC-USDT",
        //           "t": "57903921"
        //         },
        //         "dataType": "BTC-USDT@trade",
        //         "success": true
        //     }
        //
        //
        // swap
        // first snapshot
        //
        //    {
        //        "id": "2aed93b1-6e1e-4038-aeba-f5eeaec2ca48",
        //        "code": 0,
        //        "msg": '',
        //        "dataType": '',
        //        "data": null
        //    }
        //
        // subsequent updates
        //
        //
        //    {
        //        "code": 0,
        //        "dataType": "BTC-USDT@trade",
        //        "data": [
        //            {
        //                "q": "0.0421",
        //                "p": "29023.5",
        //                "T": 1690221401344,
        //                "m": false,
        //                "s": "BTC-USDT"
        //            },
        //            ...
        //        ]
        //    }
        //
        const data = this.safeValue (message, 'data', []);
        const messageHash = this.safeString (message, 'dataType');
        const marketId = messageHash.split ('@')[0];
        const isSwap = client.url.indexOf ('swap') >= 0;
        const marketType = isSwap ? 'swap' : 'spot';
        const market = this.safeMarket (marketId, undefined, undefined, marketType);
        const symbol = market['symbol'];
        let trades = undefined;
        if (Array.isArray (data)) {
            trades = this.parseTrades (data, market);
        } else {
            trades = [ this.parseTrade (data, market) ];
        }
        let stored = this.safeValue (this.trades, symbol);
        if (stored === undefined) {
            const limit = this.safeInteger (this.options, 'tradesLimit', 1000);
            stored = new ArrayCache (limit);
            this.trades[symbol] = stored;
        }
        for (let j = 0; j < trades.length; j++) {
            stored.append (trades[j]);
        }
        client.resolve (stored, messageHash);
    }

    async watchOrderBook (symbol: string, limit: Int = undefined, params = {}): Promise<OrderBook> {
        /**
         * @method
         * @name bingx#watchOrderBook
         * @description watches information on open orders with bid (buy) and ask (sell) prices, volumes and other data
         * @see https://bingx-api.github.io/docs/#/spot/socket/market.html#Subscribe%20Market%20Depth%20Data
         * @see https://bingx-api.github.io/docs/#/swapV2/socket/market.html#Subscribe%20Market%20Depth%20Data
         * @param {string} symbol unified symbol of the market to fetch the order book for
         * @param {int} [limit] the maximum amount of order book entries to return
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object} A dictionary of [order book structures]{@link https://docs.ccxt.com/#/?id=order-book-structure} indexed by market symbols
         */
        await this.loadMarkets ();
        const market = this.market (symbol);
        const [ marketType, query ] = this.handleMarketTypeAndParams ('watchOrderBook', market, params);
        if (limit === undefined) {
            limit = 100;
        } else {
            if (marketType === 'swap') {
                if ((limit !== 5) && (limit !== 10) && (limit !== 20) && (limit !== 50) && (limit !== 100)) {
                    throw new BadRequest (this.id + ' watchOrderBook() (swap) only supports limit 5, 10, 20, 50, and 100');
                }
            } else if (marketType === 'spot') {
                if ((limit !== 20) && (limit !== 100)) {
                    throw new BadRequest (this.id + ' watchOrderBook() (spot) only supports limit 20, and 100');
                }
            }
        }
        const url = this.safeValue (this.urls['api']['ws'], marketType);
        if (url === undefined) {
            throw new BadRequest (this.id + ' watchOrderBook is not supported for ' + marketType + ' markets.');
        }
        const messageHash = market['id'] + '@depth' + limit.toString ();
        const uuid = this.uuid ();
        const request = {
            'id': uuid,
            'dataType': messageHash,
        };
        if (marketType === 'swap') {
            request['reqType'] = 'sub';
        }
        const orderbook = await this.watch (url, messageHash, this.deepExtend (request, query), messageHash);
        return orderbook.limit ();
    }

    handleDelta (bookside, delta) {
        const price = this.safeFloat (delta, 0);
        const amount = this.safeFloat (delta, 1);
        bookside.store (price, amount);
    }

    handleOrderBook (client: Client, message) {
        //
        // spot
        //
        //
        //    {
        //        "code": 0,
        //        "dataType": "BTC-USDT@depth20",
        //        "data": {
        //          "bids": [
        //            [ '28852.9', "34.2621" ],
        //            ...
        //          ],
        //          "asks": [
        //            [ '28864.9', "23.4079" ],
        //            ...
        //          ]
        //        },
        //        "dataType": "BTC-USDT@depth20",
        //        "success": true
        //    }
        //
        // swap
        //
        //
        //    {
        //        "code": 0,
        //        "dataType": "BTC-USDT@depth20",
        //        "data": {
        //          "bids": [
        //            [ '28852.9', "34.2621" ],
        //            ...
        //          ],
        //          "asks": [
        //            [ '28864.9', "23.4079" ],
        //            ...
        //          ]
        //        }
        //    }
        //
        const data = this.safeValue (message, 'data', []);
        const messageHash = this.safeString (message, 'dataType');
        const marketId = messageHash.split ('@')[0];
        const isSwap = client.url.indexOf ('swap') >= 0;
        const marketType = isSwap ? 'swap' : 'spot';
        const market = this.safeMarket (marketId, undefined, undefined, marketType);
        const symbol = market['symbol'];
        let orderbook = this.safeValue (this.orderbooks, symbol);
        if (orderbook === undefined) {
            orderbook = this.orderBook ();
        }
        const snapshot = this.parseOrderBook (data, symbol, undefined, 'bids', 'asks', 0, 1);
        orderbook.reset (snapshot);
        this.orderbooks[symbol] = orderbook;
        client.resolve (orderbook, messageHash);
    }

    parseWsOHLCV (ohlcv, market = undefined): OHLCV {
        //
        //    {
        //        "c": "28909.0",
        //        "o": "28915.4",
        //        "h": "28915.4",
        //        "l": "28896.1",
        //        "v": "27.6919",
        //        "T": 1696687499999,
        //        "t": 1696687440000
        //    }
        //
        // for spot, opening-time (t) is used instead of closing-time (T), to be compatible with fetchOHLCV
        // for swap, (T) is the opening time
        const timestamp = (market['spot']) ? 't' : 'T';
        return [
            this.safeInteger (ohlcv, timestamp),
            this.safeNumber (ohlcv, 'o'),
            this.safeNumber (ohlcv, 'h'),
            this.safeNumber (ohlcv, 'l'),
            this.safeNumber (ohlcv, 'c'),
            this.safeNumber (ohlcv, 'v'),
        ];
    }

    handleOHLCV (client: Client, message) {
        //
        // spot
        //
        //   {
        //       "code": 0,
        //       "data": {
        //         "E": 1696687498608,
        //         "K": {
        //           "T": 1696687499999,
        //           "c": "27917.829",
        //           "h": "27918.427",
        //           "i": "1min",
        //           "l": "27917.7",
        //           "n": 262,
        //           "o": "27917.91",
        //           "q": "25715.359197",
        //           "s": "BTC-USDT",
        //           "t": 1696687440000,
        //           "v": "0.921100"
        //         },
        //         "e": "kline",
        //         "s": "BTC-USDT"
        //       },
        //       "dataType": "BTC-USDT@kline_1min",
        //       "success": true
        //   }
        //
        // swap
        //    {
        //        "code": 0,
        //        "dataType": "BTC-USDT@kline_1m",
        //        "s": "BTC-USDT",
        //        "data": [
        //            {
        //            "c": "28909.0",
        //            "o": "28915.4",
        //            "h": "28915.4",
        //            "l": "28896.1",
        //            "v": "27.6919",
        //            "T": 1690907580000
        //            }
        //        ]
        //    }
        //
        const data = this.safeValue (message, 'data', []);
        let candles = undefined;
        if (Array.isArray (data)) {
            candles = data;
        } else {
            candles = [ this.safeValue (data, 'K', []) ];
        }
        const messageHash = this.safeString (message, 'dataType');
        const timeframeId = messageHash.split ('_')[1];
        const marketId = messageHash.split ('@')[0];
        const isSwap = client.url.indexOf ('swap') >= 0;
        const marketType = isSwap ? 'swap' : 'spot';
        const market = this.safeMarket (marketId, undefined, undefined, marketType);
        const symbol = market['symbol'];
        this.ohlcvs[symbol] = this.safeValue (this.ohlcvs, symbol, {});
        let stored = this.safeValue (this.ohlcvs[symbol], timeframeId);
        if (stored === undefined) {
            const limit = this.safeInteger (this.options, 'OHLCVLimit', 1000);
            stored = new ArrayCacheByTimestamp (limit);
            this.ohlcvs[symbol][timeframeId] = stored;
        }
        for (let i = 0; i < candles.length; i++) {
            const candle = candles[i];
            const parsed = this.parseWsOHLCV (candle, market);
            stored.append (parsed);
        }
        client.resolve (stored, messageHash);
    }

    async watchOHLCV (symbol: string, timeframe = '1m', since: Int = undefined, limit: Int = undefined, params = {}): Promise<OHLCV[]> {
        /**
         * @method
         * @name bingx#watchOHLCV
         * @description watches historical candlestick data containing the open, high, low, and close price, and the volume of a market
         * @see https://bingx-api.github.io/docs/#/spot/socket/market.html#K%E7%BA%BF%20Streams
         * @see https://bingx-api.github.io/docs/#/swapV2/socket/market.html#Subscribe%20K-Line%20Data
         * @param {string} symbol unified symbol of the market to fetch OHLCV data for
         * @param {string} timeframe the length of time each candle represents
         * @param {int} [since] timestamp in ms of the earliest candle to fetch
         * @param {int} [limit] the maximum amount of candles to fetch
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {int[][]} A list of candles ordered as timestamp, open, high, low, close, volume
         */
        const market = this.market (symbol);
        const [ marketType, query ] = this.handleMarketTypeAndParams ('watchOHLCV', market, params);
        const url = this.safeValue (this.urls['api']['ws'], marketType);
        if (url === undefined) {
            throw new BadRequest (this.id + ' watchOHLCV is not supported for ' + marketType + ' markets.');
        }
        const options = this.safeValue (this.options, marketType, {});
        const timeframes = this.safeValue (options, 'timeframes', {});
        const interval = this.safeString (timeframes, timeframe, timeframe);
        const messageHash = market['id'] + '@kline_' + interval;
        const uuid = this.uuid ();
        const request = {
            'id': uuid,
            'dataType': messageHash,
        };
        if (marketType === 'swap') {
            request['reqType'] = 'sub';
        }
        const ohlcv = await this.watch (url, messageHash, this.extend (request, query), messageHash);
        if (this.newUpdates) {
            limit = ohlcv.getLimit (symbol, limit);
        }
        return this.filterBySinceLimit (ohlcv, since, limit, 0, true);
    }

    async watchOrders (symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params = {}): Promise<Order[]> {
        /**
         * @method
         * @name bingx#watchOrders
         * @see https://bingx-api.github.io/docs/#/spot/socket/account.html#Subscription%20order%20update%20data
         * @see https://bingx-api.github.io/docs/#/swapV2/socket/account.html#Account%20balance%20and%20position%20update%20push
         * @description watches information on multiple orders made by the user
         * @param {string} symbol unified market symbol of the market orders were made in
         * @param {int} [since] the earliest time in ms to fetch orders for
         * @param {int} [limit] the maximum number of order structures to retrieve
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object[]} a list of [order structures]{@link https://docs.ccxt.com/#/?id=order-structure}
         */
        await this.loadMarkets ();
        await this.authenticate ();
        let type = undefined;
        let market = undefined;
        if (symbol !== undefined) {
            market = this.market (symbol);
            symbol = market['symbol'];
        }
        [ type, params ] = this.handleMarketTypeAndParams ('watchOrders', market, params);
        const isSpot = (type === 'spot');
        const spotHash = 'spot:private';
        const swapHash = 'swap:private';
        const subscriptionHash = isSpot ? spotHash : swapHash;
        const spotMessageHash = 'spot:order';
        const swapMessageHash = 'swap:order';
        let messageHash = isSpot ? spotMessageHash : swapMessageHash;
        if (market !== undefined) {
            messageHash += ':' + symbol;
        }
        const url = this.urls['api']['ws'][type] + '?listenKey=' + this.options['listenKey'];
        let request = undefined;
        const uuid = this.uuid ();
        if (isSpot) {
            request = {
                'id': uuid,
                'dataType': 'spot.executionReport',
            };
        }
        const orders = await this.watch (url, messageHash, request, subscriptionHash);
        if (this.newUpdates) {
            limit = orders.getLimit (symbol, limit);
        }
        return this.filterBySymbolSinceLimit (orders, symbol, since, limit, true);
    }

    async watchMyTrades (symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params = {}): Promise<Trade[]> {
        /**
         * @method
         * @name bingx#watchMyTrades
         * @see https://bingx-api.github.io/docs/#/spot/socket/account.html#Subscription%20order%20update%20data
         * @see https://bingx-api.github.io/docs/#/swapV2/socket/account.html#Account%20balance%20and%20position%20update%20push
         * @description watches information on multiple trades made by the user
         * @param {string} symbol unified market symbol of the market trades were made in
         * @param {int} [since] the earliest time in ms to trades orders for
         * @param {int} [limit] the maximum number of trades structures to retrieve
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object[]} a list of [trade structures]{@link https://docs.ccxt.com/#/?id=trade-structure
         */
        await this.loadMarkets ();
        await this.authenticate ();
        let type = undefined;
        let market = undefined;
        if (symbol !== undefined) {
            market = this.market (symbol);
            symbol = market['symbol'];
        }
        [ type, params ] = this.handleMarketTypeAndParams ('watchOrders', market, params);
        const isSpot = (type === 'spot');
        const spotSubHash = 'spot:private';
        const swapSubHash = 'swap:private';
        const subscriptionHash = isSpot ? spotSubHash : swapSubHash;
        const spotMessageHash = 'spot:mytrades';
        const swapMessageHash = 'swap:mytrades';
        let messageHash = isSpot ? spotMessageHash : swapMessageHash;
        if (market !== undefined) {
            messageHash += ':' + symbol;
        }
        const url = this.urls['api']['ws'][type] + '?listenKey=' + this.options['listenKey'];
        let request = undefined;
        const uuid = this.uuid ();
        if (isSpot) {
            request = {
                'id': uuid,
                'dataType': 'spot.executionReport',
            };
        }
        const trades = await this.watch (url, messageHash, request, subscriptionHash);
        if (this.newUpdates) {
            limit = trades.getLimit (symbol, limit);
        }
        return this.filterBySymbolSinceLimit (trades, symbol, since, limit, true);
    }

    async watchBalance (params = {}): Promise<Balances> {
        /**
         * @method
         * @name bingx#watchBalance
         * @see https://bingx-api.github.io/docs/#/spot/socket/account.html#Subscription%20order%20update%20data
         * @see https://bingx-api.github.io/docs/#/swapV2/socket/account.html#Account%20balance%20and%20position%20update%20push
         * @description query for balance and get the amount of funds available for trading or funds locked in orders
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object} a [balance structure]{@link https://docs.ccxt.com/#/?id=balance-structure}
         */
        await this.loadMarkets ();
        await this.authenticate ();
        let type = undefined;
        [ type, params ] = this.handleMarketTypeAndParams ('watchBalance', undefined, params);
        const isSpot = (type === 'spot');
        const spotSubHash = 'spot:balance';
        const swapSubHash = 'swap:private';
        const spotMessageHash = 'spot:balance';
        const swapMessageHash = 'swap:balance';
        const messageHash = isSpot ? spotMessageHash : swapMessageHash;
        const subscriptionHash = isSpot ? spotSubHash : swapSubHash;
        const url = this.urls['api']['ws'][type] + '?listenKey=' + this.options['listenKey'];
        let request = undefined;
        const uuid = this.uuid ();
        if (type === 'spot') {
            request = {
                'id': uuid,
                'dataType': 'ACCOUNT_UPDATE',
            };
        }
        const client = this.client (url);
        this.setBalanceCache (client, type, subscriptionHash, params);
        let fetchBalanceSnapshot = undefined;
        let awaitBalanceSnapshot = undefined;
        [ fetchBalanceSnapshot, params ] = this.handleOptionAndParams (params, 'watchBalance', 'fetchBalanceSnapshot', true);
        [ awaitBalanceSnapshot, params ] = this.handleOptionAndParams (params, 'watchBalance', 'awaitBalanceSnapshot', false);
        if (fetchBalanceSnapshot && awaitBalanceSnapshot) {
            await client.future (type + ':fetchBalanceSnapshot');
        }
        return await this.watch (url, messageHash, request, subscriptionHash);
    }

    setBalanceCache (client: Client, type, subscriptionHash, params) {
        if (subscriptionHash in client.subscriptions) {
            return undefined;
        }
        const fetchBalanceSnapshot = this.handleOptionAndParams (params, 'watchBalance', 'fetchBalanceSnapshot', true);
        if (fetchBalanceSnapshot) {
            const messageHash = type + ':fetchBalanceSnapshot';
            if (!(messageHash in client.futures)) {
                client.future (messageHash);
                this.spawn (this.loadBalanceSnapshot, client, messageHash, type);
            }
        } else {
            this.balance[type] = {};
        }
    }

    async loadBalanceSnapshot (client, messageHash, type) {
        const response = await this.fetchBalance ({ 'type': type });
        this.balance[type] = this.extend (response, this.safeValue (this.balance, type, {}));
        // don't remove the future from the .futures cache
        const future = client.futures[messageHash];
        future.resolve ();
        client.resolve (this.balance[type], type + ':balance');
    }

    handleErrorMessage (client, message) {
        //
        // { code: 100400, msg: '', timestamp: 1696245808833 }
        //
        // {
        //     "code": 100500,
        //     "id": "9cd37d32-da98-440b-bd04-37e7dbcf51ad",
        //     "msg": '',
        //     "timestamp": 1696245842307
        // }
        const code = this.safeString (message, 'code');
        try {
            if (code !== undefined) {
                const feedback = this.id + ' ' + this.json (message);
                this.throwExactlyMatchedException (this.exceptions['exact'], code, feedback);
            }
        } catch (e) {
            client.reject (e);
        }
        return true;
    }

    async authenticate (params = {}) {
        const time = this.milliseconds ();
        const listenKey = this.safeString (this.options, 'listenKey');
        if (listenKey === undefined) {
            const response = await this.userAuthPrivatePostUserDataStream ();
            this.options['listenKey'] = this.safeString (response, 'listenKey');
            this.options['lastAuthenticatedTime'] = time;
            return;
        }
        const lastAuthenticatedTime = this.safeInteger (this.options, 'lastAuthenticatedTime', 0);
        const listenKeyRefreshRate = this.safeInteger (this.options, 'listenKeyRefreshRate', 3600000); // 1 hour
        if (time - lastAuthenticatedTime > listenKeyRefreshRate) {
            const response = await this.userAuthPrivatePutUserDataStream ({ 'listenKey': listenKey }); // extend the expiry
            this.options['listenKey'] = this.safeString (response, 'listenKey');
            this.options['lastAuthenticatedTime'] = time;
        }
    }

    async pong (client, message) {
        //
        // spot
        // {
        //     "ping": "5963ba3db76049b2870f9a686b2ebaac",
        //     "time": "2023-10-02T18:51:55.089+0800"
        // }
        // swap
        // Ping
        //
        try {
            if (message === 'Ping') {
                await client.send ('Pong');
            } else {
                const ping = this.safeString (message, 'ping');
                const time = this.safeString (message, 'time');
                await client.send ({
                    'pong': ping,
                    'time': time,
                });
            }
        } catch (e) {
            const error = new NetworkError (this.id + ' pong failed with error ' + this.json (e));
            client.reset (error);
        }
    }

    handleOrder (client, message) {
        //
        //     {
        //         "code": 0,
        //         "dataType": "spot.executionReport",
        //         "data": {
        //            "e": "executionReport",
        //            "E": 1694680212947,
        //            "s": "LTC-USDT",
        //            "S": "BUY",
        //            "o": "LIMIT",
        //            "q": 0.1,
        //            "p": 50,
        //            "x": "NEW",
        //            "X": "PENDING",
        //            "i": 1702238305204043800,
        //            "l": 0,
        //            "z": 0,
        //            "L": 0,
        //            "n": 0,
        //            "N": "",
        //            "T": 0,
        //            "t": 0,
        //            "O": 1694680212676,
        //            "Z": 0,
        //            "Y": 0,
        //            "Q": 0,
        //            "m": false
        //         }
        //      }
        //
        //      {
        //         "code": 0,
        //         "dataType": "spot.executionReport",
        //         "data": {
        //           "e": "executionReport",
        //           "E": 1694681809302,
        //           "s": "LTC-USDT",
        //           "S": "BUY",
        //           "o": "MARKET",
        //           "q": 0,
        //           "p": 62.29,
        //           "x": "TRADE",
        //           "X": "FILLED",
        //           "i": "1702245001712369664",
        //           "l": 0.0802,
        //           "z": 0.0802,
        //           "L": 62.308,
        //           "n": -0.0000802,
        //           "N": "LTC",
        //           "T": 1694681809256,
        //           "t": 38259147,
        //           "O": 1694681809248,
        //           "Z": 4.9971016,
        //           "Y": 4.9971016,
        //           "Q": 5,
        //           "m": false
        //         }
        //       }
        // swap
        //    {
        //        "e": "ORDER_TRADE_UPDATE",
        //        "E": 1696843635475,
        //        "o": {
        //           "s": "LTC-USDT",
        //           "c": "",
        //           "i": "1711312357852147712",
        //           "S": "BUY",
        //           "o": "MARKET",
        //           "q": "0.10000000",
        //           "p": "64.35010000",
        //           "ap": "64.36000000",
        //           "x": "TRADE",
        //           "X": "FILLED",
        //           "N": "USDT",
        //           "n": "-0.00321800",
        //           "T": 0,
        //           "wt": "MARK_PRICE",
        //           "ps": "LONG",
        //           "rp": "0.00000000",
        //           "z": "0.10000000"
        //        }
        //    }
        //
        const isSpot = ('dataType' in message);
        const data = this.safeValue2 (message, 'data', 'o', {});
        if (this.orders === undefined) {
            const limit = this.safeInteger (this.options, 'ordersLimit', 1000);
            this.orders = new ArrayCacheBySymbolById (limit);
        }
        const stored = this.orders;
        const parsedOrder = this.parseOrder (data);
        stored.append (parsedOrder);
        const symbol = parsedOrder['symbol'];
        const spotHash = 'spot:order';
        const swapHash = 'swap:order';
        const messageHash = (isSpot) ? spotHash : swapHash;
        client.resolve (stored, messageHash);
        client.resolve (stored, messageHash + ':' + symbol);
    }

    handleMyTrades (client: Client, message) {
        //
        //
        //      {
        //         "code": 0,
        //         "dataType": "spot.executionReport",
        //         "data": {
        //           "e": "executionReport",
        //           "E": 1694681809302,
        //           "s": "LTC-USDT",
        //           "S": "BUY",
        //           "o": "MARKET",
        //           "q": 0,
        //           "p": 62.29,
        //           "x": "TRADE",
        //           "X": "FILLED",
        //           "i": "1702245001712369664",
        //           "l": 0.0802,
        //           "z": 0.0802,
        //           "L": 62.308,
        //           "n": -0.0000802,
        //           "N": "LTC",
        //           "T": 1694681809256,
        //           "t": 38259147,
        //           "O": 1694681809248,
        //           "Z": 4.9971016,
        //           "Y": 4.9971016,
        //           "Q": 5,
        //           "m": false
        //         }
        //       }
        //
        //  swap
        //    {
        //        "e": "ORDER_TRADE_UPDATE",
        //        "E": 1696843635475,
        //        "o": {
        //           "s": "LTC-USDT",
        //           "c": "",
        //           "i": "1711312357852147712",
        //           "S": "BUY",
        //           "o": "MARKET",
        //           "q": "0.10000000",
        //           "p": "64.35010000",
        //           "ap": "64.36000000",
        //           "x": "TRADE",
        //           "X": "FILLED",
        //           "N": "USDT",
        //           "n": "-0.00321800",
        //           "T": 0,
        //           "wt": "MARK_PRICE",
        //           "ps": "LONG",
        //           "rp": "0.00000000",
        //           "z": "0.10000000"
        //        }
        //    }
        //
        const isSpot = ('dataType' in message);
        const result = this.safeValue2 (message, 'data', 'o', {});
        let cachedTrades = this.myTrades;
        if (cachedTrades === undefined) {
            const limit = this.safeInteger (this.options, 'tradesLimit', 1000);
            cachedTrades = new ArrayCacheBySymbolById (limit);
            this.myTrades = cachedTrades;
        }
        const parsed = this.parseTrade (result);
        const symbol = parsed['symbol'];
        const spotHash = 'spot:mytrades';
        const swapHash = 'swap:mytrades';
        const messageHash = isSpot ? spotHash : swapHash;
        cachedTrades.append (parsed);
        client.resolve (cachedTrades, messageHash);
        client.resolve (cachedTrades, messageHash + ':' + symbol);
    }

    handleBalance (client: Client, message) {
        // spot
        //     {
        //         "e":"ACCOUNT_UPDATE",
        //         "E":1696242817000,
        //         "T":1696242817142,
        //         "a":{
        //            "B":[
        //               {
        //                  "a":"USDT",
        //                  "bc":"-1.00000000000000000000",
        //                  "cw":"86.59497382000000050000",
        //                  "wb":"86.59497382000000050000"
        //               }
        //            ],
        //            "m":"ASSET_TRANSFER"
        //         }
        //     }
        // swap
        //     {
        //         "e":"ACCOUNT_UPDATE",
        //         "E":1696244249320,
        //         "a":{
        //            "m":"WITHDRAW",
        //            "B":[
        //               {
        //                  "a":"USDT",
        //                  "wb":"49.81083984",
        //                  "cw":"49.81083984",
        //                  "bc":"-1.00000000"
        //               }
        //            ],
        //            "P":[
        //            ]
        //         }
        //     }
        //
        const a = this.safeValue (message, 'a', {});
        const data = this.safeValue (a, 'B', []);
        const timestamp = this.safeInteger2 (message, 'T', 'E');
        const type = ('P' in a) ? 'swap' : 'spot';
        this.balance[type]['info'] = data;
        this.balance[type]['timestamp'] = timestamp;
        this.balance[type]['datetime'] = this.iso8601 (timestamp);
        for (let i = 0; i < data.length; i++) {
            const balance = data[i];
            const currencyId = this.safeString (balance, 'a');
            const code = this.safeCurrencyCode (currencyId);
            const account = (code in this.balance[type]) ? this.balance[type][code] : this.account ();
            account['free'] = this.safeString (balance, 'wb');
            const balanceChange = this.safeString (balance, 'bc');
            if (account['used'] !== undefined) {
                account['used'] = Precise.stringSub (this.safeString (account, 'used'), balanceChange);
            }
            this.balance[type][code] = account;
        }
        this.balance[type] = this.safeBalance (this.balance[type]);
        client.resolve (this.balance[type], type + ':balance');
    }

    handleMessage (client: Client, message) {
        if (!this.handleErrorMessage (client, message)) {
            return;
        }
        // public subscriptions
        if ((message === 'Ping') || ('ping' in message)) {
            this.spawn (this.pong, client, message);
            return;
        }
        const dataType = this.safeString (message, 'dataType', '');
        if (dataType.indexOf ('@depth') >= 0) {
            this.handleOrderBook (client, message);
            return;
        }
        if (dataType.indexOf ('@trade') >= 0) {
            this.handleTrades (client, message);
            return;
        }
        if (dataType.indexOf ('@kline') >= 0) {
            this.handleOHLCV (client, message);
            return;
        }
        if (dataType.indexOf ('executionReport') >= 0) {
            const data = this.safeValue (message, 'data', {});
            const type = this.safeString (data, 'x');
            if (type === 'TRADE') {
                this.handleMyTrades (client, message);
            }
            this.handleOrder (client, message);
            return;
        }
        const e = this.safeString (message, 'e');
        if (e === 'ACCOUNT_UPDATE') {
            this.handleBalance (client, message);
        }
        if (e === 'ORDER_TRADE_UPDATE') {
            this.handleOrder (client, message);
            const data = this.safeValue (message, 'o', {});
            const type = this.safeString (data, 'x');
            const status = this.safeString (data, 'X');
            if ((type === 'TRADE') && (status === 'FILLED')) {
                this.handleMyTrades (client, message);
            }
        }
    }
}
