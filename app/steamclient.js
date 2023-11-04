const Utils = require('./utils');
const backpack = require('./backpacktf');
const Login = require('./login');
const Confirmations = require('./confirmations');
const appConsole = require('./console');
const Prompts = require('./prompts');
const SteamTotp = require('steam-totp');
const SteamSession = require('steam-session');
const fs = require('fs');

let steam, log, Config, manager, automatic;

let communityCookies;
let g_RelogInterval = null;

exports.checkOfferCount = checkOfferCount;
exports.register = (Automatic) => {
    steam = Automatic.steam;
    log = Automatic.log;
    Config = Automatic.config;
    manager = Automatic.manager;
    automatic = Automatic;

    Login.register(Automatic);

    steam.on('debug', msg => log.debug(msg));
    steam.on('sessionExpired', () => {
        console.log('sessionExpired')
        relogSession()
    });
};

function relogSession() {
    log.verbose("Renewing session");
    main()
}

function saveCookies(cookies, quiet) {
    communityCookies = cookies;
    steam.setCookies(cookies);
    if (!quiet) log.info("Logged into Steam!");
    else log.debug("Logged into Steam: cookies set");
}

function getBackpackToken() {
    let acc = Config.account();

    if (acc && acc.bptfToken) {
        return acc.bptfToken;
    }

    return backpack.getToken();
}

exports.connect = () => {
    let acc = Config.account();
    let login;

    main(true)

}

function loginData(){
    try{
        return JSON.parse(fs.readFileSync('./accounts.json'));
    } catch {
        return false
    }
}
async function main(enableTradeManager) {
    try{


        const accountData = loginData()

        const account = accountData[accountData.lastUsedAccount] || {};

        if(!account.name || !account.password){
            const promtData = await Prompts.accountDetails();

            account.name = promtData.accountName;
            account.password = promtData.password;
        }
        if(!account.bptfToken){
            account.bptfToken = await Prompts.backpackToken();
        }
        if(!account.bptApiKey){
            account.bptApiKey = await Prompts.backpackApiKey();
        }
        if(!account.identity_secret && !account.dont_ask_identity_secret_again){
            account.identity_secret = await Prompts.identity_secret();
            if(!account.identity_secret || account.identity_secret.length < 10) account.dont_ask_identity_secret_again = true;
        }
        if(!account.sharedSecret && !account.dont_ask_sharedSecret_again){
            account.sharedSecret = await Prompts.sharedSecret();
            if(!account.sharedSecret || account.sharedSecret.length < 10) account.dont_ask_sharedSecret_again = true;
        }
        Config.saveAccount(account.name, account);
        // Create a LoginSession for us to use to attempt to log into steam
        let session = new SteamSession.LoginSession(SteamSession.EAuthTokenPlatformType.MobileApp);

        // Go ahead and attach our event handlers before we do anything else.
        session.on('authenticated', async () => {
            let cookies = await session.getWebCookies();

            saveCookies(cookies)
            if(enableTradeManager) setupTradeManager()
                else {
                    manager.setCookies(communityCookies) 
                }
        });

        session.on('timeout', () => {
            console.log('This login attempt has timed out.');
            relogSession()
        });

        session.on('error', (err) => {
            console.log(`ERROR: This login attempt has failed! ${err.message}`);
        });

        // Start our login attempt
        let startResult = await session.startWithCredentials({accountName: account.name, password: account.password});
        if (startResult.actionRequired) {

            let codeActionTypes = [SteamSession.EAuthSessionGuardType.EmailCode, SteamSession.EAuthSessionGuardType.DeviceCode];
            let codeAction = startResult.validActions.find(action => codeActionTypes.includes(action.type));
            if (codeAction) {
                if (codeAction.type == SteamSession.EAuthSessionGuardType.EmailCode) {
                    // We wouldn't expect this to happen since mobile confirmations are only possible with 2FA enabled, but just in case...
                    console.log(`A code has been sent to your email address at ${codeAction.detail}.`);
                } else {
                    console.log('You need to provide a Steam Guard Mobile Authenticator code.');
                }

                let sharedSecret = account.sharedSecret;
                if (sharedSecret && sharedSecret.length > 10) {
                    // The code might've been a shared secret
                   
                    const code = SteamTotp.getAuthCode(sharedSecret);
                    
                    await session.submitSteamGuardCode(code);

                } else {
                    const code = await Prompts.steamGuardCode("SteamGuardMobile")
                       
                    await session.submitSteamGuardCode(code);
                  
                }

            }
        }
    } catch(err){
        console.log(err)
        //setTimeout(function() {relogSession();}, 1000 * 60 * 5);
    }
}

function tryLogin() {
    return new Promise((resolve) => {
        function retry() {
            return tryLogin().then(resolve);
        }

        Login.isLoggedIn().then(resolve).catch(([err, loggedIn, familyView]) => {
            if (err) {
                log.error("Cannot check Steam login: " + err);
                Utils.after.seconds(10).then(retry);
            } else if (!loggedIn) {
                log.warn("Saved OAuth token is no longer valid.");
                Login.promptLogin().then(saveCookies).then(retry);
            } else if (familyView) {
                log.warn("This account is protected by Family View.");
                Login.unlockFamilyView().then(retry);
            }
        });
    });
}

function heartbeatLoop() {
    function loop(timeout) { setTimeout(heartbeatLoop, timeout); }
    backpack.heartbeat().then(loop).catch(loop);
}

async function setupTradeManager() {
    try{

        const timeout = await backpack.heartbeat()
      
        if (timeout === "getToken") {
            return backpack.getToken().then(setupTradeManager);
        }
        if (timeout === "getApiKey") {
            return backpack.getApiKey().then(setupTradeManager);
        }
        const acc = Config.account();

        if (Confirmations.enabled()) {
            if (acc.identity_secret) {
                log.info("Starting Steam confirmation checker (accepting " + automatic.confirmationsMode() + ")");
                Confirmations.setSecret(acc.identity_secret);
            } else {
                log.warn("Trade offers won't be confirmed automatically. In order to automatically accept offers, you should supply an identity_secret. Type help identity_secret for help on how to do this. You can hide this message by typing `confirmations none`.");
            }
        } else {
            log.verbose("Trade confirmations are disabled, not starting confirmation checker.");
        }
      

        // Start the input console
        log.debug("Launching input console.");
        appConsole.startConsole(automatic);
        
        if (!g_RelogInterval) {
            //g_RelogInterval = setInterval(relog, 1000 * 60 * 60 * 1); // every hour
        }
        setTimeout(heartbeatLoop, timeout);

        manager.setCookies(communityCookies, (err) => {
            if (err) {
                log.error("Can't get apiKey from Steam: " + err);
                process.exit(1);
            }

            log.info(`Automatic ready. Sell orders enabled; Buy orders ${automatic.buyOrdersEnabled() ? "enabled" : "disabled (type buyorders toggle to enable, help buyorders for info)"}`);
            checkOfferCount();
            setInterval(checkOfferCount, 1000 * 60 * 5);
        });
    } catch(err){
        console.log(err, 'err')
        Utils.after.timeout(1000 * 60 * 1).then(setupTradeManager);
        
    };
}

function relog() {
    const acc = Config.account();
    if (acc && acc.sentry && acc.oAuthToken) {
        log.verbose("Renewing web session");
        Login.oAuthLogin(acc.sentry, acc.oAuthToken, true).then((cookies) => {
            saveCookies(cookies, true);
            log.verbose("Web session renewed");
        }).catch((err) => {
            log.debug("Failed to relog (checking login): " + err.message);
            Login.isLoggedIn()
                .then(() => log.verbose("Web session still valid"))
                .catch(() => log.warn("Web session no longer valid. Steam could be down or your session might no longer be valid. To refresh it, log out (type logout), restart Automatic, and re-enter your credentials"));
        });
    } else {
        log.verbose("OAuth token not saved, can't renew web session.");
    }
}

function checkOfferCount() {
    if (manager.apiKey === null) return;

    return Utils.getJSON({
        url: "https://api.steampowered.com/IEconService/GetTradeOffersSummary/v1/?key=" + manager.apiKey
    }).then(([_, response]) => {
        if (!response) {
            log.warn("Cannot get trade offer count: malformed response");
            log.debug(`apiKey used: ${manager.apiKey}`);
            return;
        }

        let pending_sent = response.pending_sent_count,
            pending_received = response.pending_received_count;

        log.verbose(`${pending_received} incoming offer${pending_received === 1 ? '' : 's'} (${response.escrow_received_count} on hold), ${pending_sent} sent offer${pending_sent === 1 ? '' : 's'} (${response.escrow_sent_count} on hold)`);
    }).catch((msg) => {
        log.warn("Cannot get trade offer count: " + msg);
        log.debug(`apiKey used: ${manager.apiKey}`);
    });
}
