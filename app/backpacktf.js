const TradeOfferManager = require('steam-tradeoffer-manager');
const AutomaticOffer = require('./automatic-offer');
const Utils = require('./utils');
const Prompts = require('./prompts');


var fs = require('fs')
let manager, log, Config, automatic;

exports.heartbeat = heartbeat;
exports.register = register;
exports.handleBuyOrdersFor = handleBuyOrdersFor;
exports.handleSellOrdersFor = handleSellOrdersFor;
exports.finalizeOffer = finalizeOffer;
exports.getToken = getToken;
exports.getApiKey = getApiKey;
exports.exchangeCurrencies = exchangeCurrencies;
exports.handleSellOrder = handleSellOrder;

function register(Automatic) {
    manager = Automatic.manager;
    log = Automatic.log;
    Config = Automatic.config;
    community = Automatic.steam;
    automatic = Automatic;
}

let offerSummaries = {}; // oid: summary

function getToken() {
    return Prompts.backpackToken().then((token) => {
        let acc = Config.account();
        acc.bptfToken = token;
        Config.saveAccount(acc);

        return token;
    });
}
function getApiKey() {
    return Prompts.backpackApiKey().then((apikey) => {
        let acc = Config.account();
        acc.bptApiKey = apikey;
        Config.saveAccount(acc);

        return apikey;
    });
}



function updateBuyOrders(body) {
    // buy orders disabled, or no updates (etag)
    if (!automatic.buyOrdersEnabled() || !body.listings) {
        return {updated: false, added: 0, removed: 0};
    }

    const oldOrders = automatic.buyOrders;
    const newOrders = body.listings.filter(function (item) {
        return item.buyout === 1 && item.intent === 0; // intent=0 are buy orders, buyout is a feature
    });
    automatic.buyOrdersEtag = body.etag;
    automatic.buyOrders = newOrders;

    const oldIds = oldOrders.map((listing) => listing.id);
    const newIds = newOrders.map((listing) => listing.id);
    let added = 0,
        removed = 0;

    oldIds.forEach((id) => {
        if (newIds.indexOf(id) === -1) removed += 1;
    });
    newIds.forEach((id) => {
        if (oldIds.indexOf(id) === -1) added += 1;
    });

    const updated = added > 0 || removed > 0;
    return {updated, added, removed};
}

async function heartbeat() {

    try{

        const token = Config.account().bptfToken;
        const apiKey = Config.account().bptApiKey;
        const boEnabled = automatic.buyOrdersEnabled();
        const etag = automatic.buyOrdersEtag;

        let params = {
            method: "alive",
            token: token,
            i_understand_the_risks: "true",
            intent: "0",
            item_names: "1",
            automatic: "all"
        };
        
        if (boEnabled && etag) params.etag = etag;

        const [resp, resp2] = await Utils.postJSON({
                url: automatic.apiPath("IGetCurrencies/v1"),
                checkResponse: true,
                form: {key: apiKey}
        })

        if(!resp2?.currencies?.keys?.price?.value) throw(['Cannot get keys data', 403])

        automatic.keyPrice = resp2.currencies.keys.price.value;

        await Utils.postJSON2({
            url: automatic.apiPath("aux/heartbeat/v1"),
            form: params
          })

        const [body] = await Utils.postJSON({
                url: automatic.apiPath("classifieds/listings/v1"),
                form: params
            })
                
        let updates = [];
        
        let currenciesChanged = JSON.stringify(automatic.listings) !== JSON.stringify(body.listings); // might change later to be more efficient
        let buyOrdersChanged = updateBuyOrders(body);
        let bumped = body.bumped;

        automatic.listings = body.listings;

        if (bumped) {
            updates.push(`${bumped} listing${bumped === 1 ? '' : 's'} bumped.`);
        }
        if (body.listings) {
            log.info("Your listings were updated.");
        }
        if (currenciesChanged) {
            updates.push(`Community suggested currency exchange rates updated.`);
        }
        if (buyOrdersChanged.updated) {
            let boupdates = [];
            if (buyOrdersChanged.added) boupdates.push(`+${buyOrdersChanged.added} buy order(s)`);
            if (buyOrdersChanged.removed) boupdates.push(`-${buyOrdersChanged.removed} buy order(s)`);
            if (boupdates.length) updates.push(boupdates.join(", ") + ".");
        }

        log[updates.length ? "info" : "verbose"](`Heartbeat sent to backpack.tf. ${updates.join(" ")}`);
        return(1000 * 95);

    } catch(err){
        const [msg, statusCode, data] = err

        if(data?.response?.message){
            log.warn("Invalid backpack.tf api: " + data.response.message || "(no reason given)");
            return ("getApiKey");
        }

        if(data && data.message && data.message.includes('access token')){
            log.warn("Invalid backpack.tf token: " + data.message || "(no reason given)");
            return ("getToken");
        }

        if (Array.isArray(msg) && msg.length === 3) { // Cloudflare
            msg = msg[0] + "; backpack.tf may be down, or you are captcha'd by Cloudflare (only if you experience this problem on other sites)."
        }

        log.warn(`Error ${statusCode || ""} occurred contacting backpack.tf (${msg}), trying again in 1 minute`.trim());

        return(1000 * 60 * 1);
    }

}
   
 

/* Trading */
function diffBuyOrder(offer, cur, item, allignore) {
    // we're buying items, so we add additional value to their values, instead of reducing value from us. doing this allows us to handle item-item exchanges
    // example: ours=<sell order - 3.66>,<1.33 ref>; theirs=<item from buy order - 2 ref>,<2 ref>
    // before this calculation, ours=1.33;theirs=2
    // after: ours=1.33;theirs=4
    // later we add value according to our listings, so ours=4;theirs=4
    let theirs = offer.currencies.theirs;
    let ignored = [];

    // it's being treated as a craft weapon even though we're putting more value to it, so remove that previously implied value
    if (AutomaticOffer.isCraftWeapon(item)) {
        theirs.metal -= 1/18;
    }

    if (cur.metal) {
        theirs.metal += cur.metal;
    }

    if (cur.keys) {
        theirs.keys += cur.keys;
        
        let diff = cur.keys;
        for (let i = 0; i < offer.exchange.ours.length; i += 1) {
            const item = offer.exchange.ours[i];
            if (AutomaticOffer.isKey(item, true) && allignore.indexOf(i) === -1) {
                diff -= 1;
                ignored.push(i);
                if (diff === 0) break;
            }
        }
    }

    return ignored;
}

function createUserItemDict(theirs) {
    let items = {};

    // This creates a list of items to diff against the user's buy orders with a tag (<defindex>_<quality>=[...indices])
    for (let index = 0; index < theirs.length; index += 1) {
        const item = theirs[index];
        const appdata = item.app_data;

        // abort offer handling if these fields are missing due to Steam
        if (!appdata) return false;

        let defindex = +appdata.def_index;

        const fixDefindexBug = {
            205: 18, 211: 29, 737: 25, 199: 10, 160: 294, 210: 24, 212: 30
        }
       
        defindex = fixDefindexBug[defindex] || defindex;


        const item_is_australium = AutomaticOffer.itemAustralium(item);
        //const fest = AutomaticOffer.itemFestive(item);
        if (!defindex) return false;
        
//AutomaticOffer.itemIsAustralium(item)
        const qualit = +appdata.quality || 0; // Normal quality items don't have a 'quality', so we set this to 0 manually

        const skin = AutomaticOffer.StrangeSkin(item);
        const quality = skin === 15 ? 15 : qualit;
        const matchName = AutomaticOffer.toBackpackName(item);
        //console.log(defindex, matchName)
     // ignore metal
        if (AutomaticOffer.isMetal(item)) continue;
        
        let tag = defindex + "_" + quality + "_" + item_is_australium;
        if (quality !== 11) tag = defindex + "_" + quality + "_" + item_is_australium + "_" + matchName;
        
        (items[tag] = (items[tag] || [])).push(index);
    }
    return items;
}

function applyFilter(obj, prop, arr, filter) {
    if (filter.length) {
        obj[prop] = arr.filter((_, index) => filter.indexOf(index) === -1);
    } else {
        obj[prop] = arr;
    }
}

function eqParticle(item, bpItem) {
    let particle = AutomaticOffer.itemParticleEffect(item);

    if (particle) {
        let bpName = AutomaticOffer.toBackpackName(item); // remove quality and prepend particle name
        // particles must match; item.flags.item_name is something like "Burning Flames Team Captain" if the item has a particle
        // since the inventory json api doesn't support particle ids in item_data, we have to work with strings
        return bpName === bpItem.item.name;
    }

    return false;
}

function findParticleMatch(item, matches) {
    for (let i = 0; i < matches.length; i += 1) {
        let match = matches[i];
        if (eqParticle(item, match)) {
            return match;
        }
    }
}


function buyItem(offer, bpItem, invItem, invItemIndex, oursignore, theirsignore) {
    // diffBuyOrder returns an array on success with a list of items that are 'handled', thus removed from .items
    // oursignore is checked for items already ignored
    let ignore = diffBuyOrder(offer, bpItem.currencies, invItem, oursignore);

    oursignore = oursignore.concat(ignore);
    theirsignore.push(invItemIndex); // don't add this handled item to exchange.theirs
    if(!offer.stocklimit) offer.stocklimit = [];
    offer.stocklimit.push(AutomaticOffer.toBackpackName(invItem));
    offer.bought.push(invItemIndex);
}

function handleBuyOrdersFor(offer) {
    const ours = offer.exchange.ours;
    const theirs = offer.exchange.theirs;
    const bo = automatic.listings;

    if (!automatic.buyOrdersEnabled() || bo.length === 0) {
        offer.items.ours = ours;
        offer.items.theirs = theirs;
        return;
    }

    let oursignore = [];
    let theirsignore = [];

    let items = createUserItemDict(theirs);
    let unusuals = new Map();

    if (items === false) {
        offer.abandon({recheck: true});
        return false;
    }

    // Diff the offer's items with the list of buy orders
    for (let i = 0; i < bo.length; i += 1) {

        const item = bo[i];
        const quality = item.item.quality;

        var attr = item.item.attributes;

        const item_is_australium = !attr ?  0 : attr.find(el => Number(el.defindex) === 2027) ? 1 : 0;
        //const fest = attr === 2053 ? 1 : 0;
        const matchName = item.item.name;

        let tag = item.item.defindex + "_" + quality + "_" + item_is_australium;

        if (quality !== 11) tag = item.item.defindex + "_" + quality + "_" + item_is_australium + "_" + matchName;

        // ignore: if this buy order item isn't in the trade offer
        const indices = items[tag];

        if (!indices) continue;
        
        if(item.item.name === 'Mann Co. Supply Crate Key') continue;

        const listingParticle = (item.item.attributes && item.item.attributes[0].float_value) || 0;
        const uncraft = !!item.item.flag_cannot_craft;
        const nonname = item.item.name;

        let killstreak = (item.item.attributes && item.item.attributes[0].float_value) || 0;
        if(matchName.indexOf('Killstreak') === -1) killstreak = 0;
        
        // ignoring items here will make them be handled by sell orders, where they can't pass and therefore the offer won't go through
        // Iterate the list of matching items in the offer
        for (let i2 = 0; i2 < indices.length; i2 += 1) {
            const index = indices[i2];
            const orig = theirs[index];

            // Unusuals are double checked later to see if here is a iclelesspart and a particle listing of a certain unusual, in which case the particle one takes priority.
            if (quality === 5) { // Unusual
                orig.__index = index;
                let u = unusuals.get(orig) || [];
                u.push(item);
                unusuals.set(orig, u);

                continue;
            }

            // if the listing has a particle, it must match
            if (quality === 5 && listingParticle) {
                if (!eqParticle(orig, item)) {
                    continue;
                }
            }

            if (uncraft !== AutomaticOffer.itemIsUncraftable(orig)) {
                // ignore: not matching item craftability
                continue;
            }

            // killstreak tier must match
            if (Number(killstreak) !== Number(AutomaticOffer.itemKillstreakTier(orig))) {
                continue;
           }
            

            buyItem(offer, item, orig, index, oursignore, theirsignore);
        }
        
    }

    for (let [orig, matches] of unusuals) {
        let match = findParticleMatch(orig, matches);

        if (!match) {
            let generic;
            for (let i = 0; i < matches.length; i += 1) {
                let item = matches[i];

                if (!item.flags || !item.flags.particle) {
                    generic = item;
                    break;
                }
            }
            
            if (generic) match = generic;
        }
        
        if (match) {
            buyItem(offer, match, orig, orig.__index, oursignore, theirsignore);
        }
    }
    

    applyFilter(offer.items, 'ours', ours, oursignore);
    applyFilter(offer.items, 'theirs', theirs, theirsignore);
}

function handleOther(offer, other) {
	//console.log(serializeOffer(offer))
    if (other && (other.scammer || other.banned)) {
        const decline = Config.get().declineBanned;
        offer.log("info", `sender is marked as a scammer or banned${decline ? ", declining" : ""}`);

        if (decline) {
            offer.decline()
            .then(() => offer.log("debug", `declined`)).catch((err) => {
                offer.log("warn", "Something error with declining this offer")
            });
        }

        return false;
    }

    return true;
}

function exchangeCurrencies(ours, theirs, options) {
    let keysAverage = options.keysAverage || null;
    let mayExchangeToMetal = options.mayExchangeToMetal || false;
    let mayExchangeToKeys = options.mayExchangeToKeys || false;

    // TODO: 1.3.1: hard disable of currency exchange, something is insecure.
    mayExchangeToMetal = false;
    mayExchangeToKeys = false;

    if (!keysAverage) {
        // TODO: 1.3.2: 1.3.1 is throwing problems here.
        // Apparently the old version worked on magic because there never
        // was a low/high value returned by the Automatic HeartBeat API
        // what the hell is going on here?
        // Since we're still not using currency exchange because it is broken,
        // we can just comment it out for now.
        // throw new Error("keysAverage not set, quitting.");
    }

    let metalOk = true;
    let keysOk = true;

    // currency required
    if (ours.metal !== 0) {
        // asking for more than they offer
        if (ours.metal > theirs.metal) {
            metalOk = false;
            if (theirs.keys > 0 && mayExchangeToMetal) {
                let tv = trunc(theirs.metal + theirs.keys * keysAverage);
                metalOk = tv >= ours.metal && tv >= 0;

                if (metalOk) {
                    // remove the value tested for above
                    // if oM = 30, tM = 20, keysavg = 10, oK = 1, tK = 3.5
                    // then tv = 20 + 3.5*10 (55) (full ov = 40)
                    // thus tK needs to be decreased by (30 - 20) / 10 = 10/10 = 1 key, this still makes (30 + 2.5*10 = 55)
                    let diff = trunc(ours.metal - theirs.metal);
                    theirs.metal += diff; // this sets tM = oM
                    theirs.keys -= diff / keysAverage;
                }
            }
        }
    }

    // currency required
    if (metalOk && ours.keys !== 0) {
        // asking for more than they offer
        if (ours.keys > theirs.keys) {
            keysOk = false;
            if (theirs.metal > 0 && mayExchangeToKeys) {
                let tv = trunc(theirs.keys + theirs.metal / keysAverage);
                keysOk = tv >= ours.keys && tv >= 0;

                // remove the value tested for above
                // with both exchanges enabled
                // if oK = 3, tK = 3, keysavg = 10, oM = 10, tM = 1
                // then (above - metal) tv = 1 + 3 * 10 = 31 (> 10, tM += 10 - 1 (then equals oM), tK -= (9 / 10) = 0.9)
                // oK = 3, tK = 2.1, oM = 10, tM = 10
                // results oK > tK, so we do another exchange if it's enabled
                // it's okay, because it's do-able (we can remove (3-2.1)*10 = 9 ref);
                // results in oK = 3, tK = 2.1, tv = 3, oM = 10, tM = 1 (so here's where we must alter value)
                // -= 3-2.1 * 10 = 0.9 * 10 = 9; tM = 1
                theirs.metal -= trunc((ours.keys - theirs.keys) * keysAverage);

                // now we have to check oM > tM again
                if (ours.metal > theirs.metal) {
                    // further checking is useless, there's simply not enough metal in this offer
                    metalOk = false;
                }
            }
        }
    }

    return {keysOk: keysOk, metalOk: metalOk};
}

function handleSellOrder(offer, listings) {

    if (listings.length === 0 && offer.bought.length === 0) {

        offer.log("info", `No matching listings found for offer, skipping.`);
        offer.logDetails("info");
        return false;
    }

    // stock limit checking
    var stock = [];
    var stocklimit = offer.stocklimit || [];

    if (stocklimit.length > 1){
        var stockname = [];
        var nextname = [];
        var stocklist = [];
        var uniquestock = unique(stocklimit);
   
        for(let i = 0; i < uniquestock.length; i+=1){
            stockname = uniquestock[i];
            let count = 0;
            for(let p = 0; p < stocklimit.length; p+=1){
                if(stockname === stocklimit[p]){
                    count += 1;
                }
            }
            stock.push({
                stockname, count
            });
        }
    
        for(let j = 0; j < stock.length; j += 1){
            stocklist[j] = stock[j].count;
        }
        let stockmax = Math.max.apply(null, stocklist);
        if(stockmax > 1){

           offer.log("info", `to much items were sent. stocklimit 2`);
           return false;
        }
    }
    
    // end stock limit check 

    let ours = offer.currencies.ours;
    let theirs = offer.currencies.theirs;
    let listingids = {};

    // check if all items are in here
    // and add required values to each side
    listings.forEach((listing) => {
        if (listing.item) {
            listingids[listing.item.id] = true;
        }

        for (let cur in listing.currencies) {
            ours[cur] += listing.currencies[cur];
        }

        // user is selling keys for metal, reduce key count
        // results in ours.metal += <listing price> ours.keys -= 1
        if (listing.defindex === 5021 && listing.quality === 6) {
            ours.keys -= 1;
        }
    });

    // checks leftover items to handle (not items handled by buy orders above)
    for (let i = 0; i < offer.items.ours.length; i += 1) {
        let item = offer.items.ours[i];

        // ignore: metal & keys, these are checked for currency equivalency later
        if (AutomaticOffer.isMetal(item) || AutomaticOffer.isKey(item)) continue;

        let id = item.assetid || item.id;
        if (!listingids.hasOwnProperty(id)) {
            offer.log("info", `contains an item that isn't in a listing (${AutomaticOffer.toBackpackName(item)}), skipping`);
            offer.logDetails("info");
            return false;
        }
    }

    // complete this step first for currency exchange
    for (let cur in ours) {
        // Truncate everything past the second decimal place
        ours[cur] = trunc(ours[cur]);
        theirs[cur] = trunc(theirs[cur]);
    }
    if(!automatic.keyPrice || typeof automatic.keyPrice != 'number' || automatic.keyPrice < 10) {
        log.warn(`There are some problem with automatic key price ${automatic.keyPrice}`)
        return false
    }
    // Fix x.99999 metal values
    if (ours.metal % 1 >= 0.99) ours.metal = Math.ceil(ours.metal);
    if (theirs.metal % 1 >= 0.99) theirs.metal = Math.ceil(theirs.metal);
    if (theirs.metal % 1 >= 0.1) theirs.metal = theirs.metal + 0.01;
    //if (theirs.keys > ours.keys && ours.metal <= ref) ours.metal = 0;
    if (theirs.keys == ours.keys && theirs.keys >= 2 && Math.floor(ours.metal) == Math.floor(theirs.metal)) theirs.metal = ours.metal;
    if (theirs.keys == ours.keys && theirs.keys >= 2 && Math.ceil(ours.metal) == Math.ceil(theirs.metal)) theirs.metal = ours.metal;
 
    let theirsPrice = theirs.keys + (theirs.metal / automatic.keyPrice);
    let oursPrice = ours.keys + (ours.metal / automatic.keyPrice);

    if (theirs.keys === ours.keys && theirs.keys < 2) {
        theirsPrice = Number(theirsPrice.toFixed(3));
        oursPrice = Number(oursPrice.toFixed(3))
    }

    let priceOk = theirsPrice >= oursPrice;

    let {metalOk: metalOk, keysOk: keysOk} = exchangeCurrencies(ours, theirs, {
        keysAverage: automatic.currencyAvg("keys"),
        mayExchangeToMetal: automatic.mayExchangeToCurrency("metal"),
        mayExchangeToKeys: automatic.mayExchangeToCurrency("keys")
    });

    if (!priceOk) {
        if (!metalOk) {
            offer.log("info", `doesn't offer enough metal (required = ${ours.metal}, given = ${theirs.metal}), skipping.`);
        }
        if (!keysOk) {
            offer.log("info", `doesn't offer enough keys (required = ${ours.keys}, given = ${theirs.keys}), skipping.`);
        }

        offer.log("info", `doesn't offer enough price (required = ${oursPrice}, given = ${theirsPrice}), skipping.`);
        offer.logDetails("info");
        return false;
    }
    
    offer.log("trade", `required = ${oursPrice}, given = ${theirsPrice}`);

    return true;

}

function unique(arr) {
  var obj = {};

  for (var i = 0; i < arr.length; i++) {
    var str = arr[i];
    obj[str] = true; 
  }

  return Object.keys(obj); 
}

function handleSellOrdersFor(offer) {

    return getUserTrades(offer).then(([_, response]) => {
 
        if (!handleOther(offer, response.other)) {
            return false;
        }

        return handleSellOrder(offer, response.store);
    });
}

function obvious_Scammer(offer){
	let id = offer.partner64();
	
	let profileis = 0;
	let created_time = 0;
	let steamlvl = 0;

	const half_year = 15768000;
	let time_check = Math.floor(Date.now() / 1000) - half_year;
	
	//https://api.steampowered.com/IPlayerService/GetSteamLevel/v1
	let options = {
		url: 'https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/?key=' + manager.apiKey + '&steamid=' + id
	}
	
	var p1 = new Promise((resolve, reject) => {

    	Utils.getJSON(options).then(([body]) => {
    		steamlvl = Number(body.response.player_level);
         })
        .then(() => {

        	Utils.getJSON({
                url: 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v1/?key=' + manager.apiKey + '&steamids=' + id
            }).then(([body]) => {
            	body = body.response.players.player[0];
          
            	//public = 3 private 1
            	profileis = Number(body.communityvisibilitystate) || 0;
            	// can be undefined if prodileis = 1 or 2
            	created_time = Number(body.timecreated) || 0;
            	resolve('work');
            });
        });
    });

    return p1.then(function(result) {
    	
    	if(steamlvl < 4 || created_time > time_check || profileis === 1) {
    		//console.log(steamlvl + ' ' + created_time + ' ' + profileis)
    		offer.log("info", `this trade can be with obvious scammer, check manual`);
    		return false;
    	} else { 

    		return true;
    	}
    });
}
function getUserTrades(offer) {
    // list of items after handling buy orders
    const selling = offer.items.ours
        .map((item) => item.assetid || item.id);

    let options = {
            url: automatic.apiPath("IGetUserTrades/v1"),
            qs: {
                "steamid": automatic.getOwnSteamID(),
                "steamid_other": offer.partner64(),
                "ids": selling
            },
            checkResponse: true
    }

    return Utils.getJSON(options).catch((msg, statusCode) => {
        let m = msg;

        if (Array.isArray(msg) && msg.length === 3) { // Cloudflare
            msg = msg[0] + "; backpack.tf may be down, or you are captcha'd by Cloudflare (only if you experience this problem on other sites)."
        } else if (statusCode >= 500) {
            m = "backpack.tf is down (" + statusCode + ")";
        }

        log.warn("Error occurred getting sell listings (" + m + "), trying again in 1 minute.");
        return Utils.after.minutes(1).then(() => handleSellOrdersFor(offer));
    });
}

/** Accept offer **/
function checkEscrowed(offer) {
	const acceptEscrow = Config.get().acceptEscrow;
	if (acceptEscrow === true) {
		return Promise.resolve(false); // user doesn't care about escrow
	}

    return offer.determineEscrowDays().then((escrowDays) => {
        if (escrowDays > 0) {
            if (acceptEscrow === "decline") {
                offer.log("info", `would incur an escrow period, declining.`);
                offer.decline()
                .then(() => offer.log("debug", `declined`)).catch(err =>{
                    offer.log("warn", "Cannot decline this offer")
                });
            } else {
                offer.warn("warn", `would incur up to ${escrowDays} escrow. Not accepting.`);
            }

            return true;
        }

        return false;
    });
}

function finalizeOffer(offer) {
    checkEscrowed(offer).then((escrowed) => {
        if (!escrowed) {
            acceptOffer(offer);
        }
    }).catch(err => {
        console.log('Error in finalizeOffer', err)
    })
}

function acceptOffer(offer, tryAgain) {
    // Everything looks good
   
    const secret = Config.account().identity_secret;
    let message = offer.summary({includeBuyOrders: true});

    offer.log("trade", "Accepting, summary:\r\n" + message);


    offerSummaries[offer.tid] = message;

    offer.accept().then((status) => {
        offer.log("trade", `successfully accepted${status === 'pending' ? "; confirmation required" : ""}`);
        if(status === 'pending'){
           accept_offer(offer, secret);

        }
    }).catch((msg) => {
        offer.log("warn", `unable to accept: ${msg}`);
        if(!tryAgain){
            offer.log("warn", `will try 1 more time in 30 seconds`);
            setTimeout(function() {
                acceptOffer(offer, true)
            }, 1000 * 30);
        }
    });
}

function accept_offer(offer){
    let partner_steam_id = offer.tradeoffer.partner.accountid;
    const secret = Config.account().identity_secret;
    let id = offer.tradeoffer.id;

   //console.log(partner_steam_id);
    
            community.acceptConfirmationForObject(secret, id, function(err) {
                            if (err) {
                                //console.log(err);
                                //setTimeout(function() {accept_offer(offer); }, 1000 * 10);
                                
                            } else {
                                offer.log("trade", `Offer ${id} confirmed`);
                            }
                        })
}
/** Notify backpack.tf **/

// These work on raw tradeoffer objects
function extractAssetInfo(item) {
    return {
        "appid": item.appid,
        "contextid": item.contextid,
        "assetid": item.assetid || item.id,
        "classid": item.classid,
        "instanceid": item.instanceid || "0",
        "amount": item.amount || "1",
        "missing": item.missing ? "true" : "false"
    };
}

function serializeOffer(offer) {
    return {
        "tradeofferid": offer.id,
        "accountid_other": offer.partner.accountid,
        "steamid_other": offer.partner.getSteamID64(),
        "message": offer.message,
        "expiration_time": Math.floor(offer.expires.getTime() / 1000),
        "trade_offer_state": offer.state,
        "is_our_offer": offer.isOurOffer ? "true" : "false",
        "time_created": Math.floor(offer.created.getTime() / 1000),
        "time_updated": Math.floor(offer.updated.getTime() / 1000),
        "from_real_time_trade": offer.fromRealTimeTrade ? "true" : "false",
        "items_to_give": offer.itemsToGive.map(extractAssetInfo),
        "items_to_receive": offer.itemsToReceive.map(extractAssetInfo),
        "confirmation_method": offer.confirmationMethod || 0,
        "escrow_end_date": offer.escrowEnds ? Math.floor(offer.escrowEnds.getTime() / 1000) : 0
    };
}


function trunc(n) { return Math.floor(n * 100) / 100; }