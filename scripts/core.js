var appGlobal = {
    feedlyApiClient: new FeedlyApiClient(),
    icons: {
        default: "/images/icon.png",
        inactive: "/images/icon_inactive.png",
        defaultBig: "/images/icon128.png"
    },
    options: {
        updateInterval: 2, //minutes
        markReadOnClick: true,
        accessToken: "",
        showDesktopNotifications: true,
        hideNotificationDelay: 60, //seconds
        showFullFeedContent: false,
        maxNotificationsCount: 5
    },
    //Names of options after changes of which scheduler will be initialized
    criticalOptionNames: ["updateInterval", "accessToken", "showFullFeedContent"],
    cachedFeeds: [],
    isLoggedIn: false,
    intervalId : 0
};

// #Event handlers
chrome.runtime.onInstalled.addListener(function (details) {
    //Trying read old options (mostly access token) if possible
    readOptions(function () {
        //Write all options in chrome storage and initialize application
        writeOptions(initialize);
    });
});

chrome.storage.onChanged.addListener(function (changes, areaName) {
    var callback;

    for(var optionName in changes){
        if(appGlobal.criticalOptionNames.indexOf(optionName) !== -1 ){
            callback = initialize;
            break;
        }
    }
    readOptions(callback);
});

chrome.runtime.onStartup.addListener(function () {
    readOptions(initialize);
});

/* Listener for adding or removing feeds on the feedly website */
chrome.webRequest.onCompleted.addListener(function(details) {
    if(details.method === "POST" || details.method === "DELETE"){
        updateFeeds();
    }
}, {urls: ["*://cloud.feedly.com/v3/subscriptions*", "*://cloud.feedly.com/v3/markers?*ct=feedly.desktop*"]});

/* Initialization all parameters and run feeds check */
function initialize() {
    appGlobal.feedlyApiClient.accessToken = appGlobal.options.accessToken;
    startSchedule(appGlobal.options.updateInterval);
}

function startSchedule(updateInterval) {
    stopSchedule();
    updateFeeds();
    appGlobal.intervalId = setInterval(updateFeeds, updateInterval * 60000);
}

function stopSchedule() {
    clearInterval(appGlobal.intervalId);
}

/* Sends desktop notifications */
function sendDesktopNotification(feeds){
    var notifications = [];
    //if notifications too many, then to show only count
    if(feeds.length > appGlobal.options.maxNotificationsCount){
        //We can detect only 20 new feeds at time, but actually count of feeds may be more than 20
        var count = feeds.length === 20 ? chrome.i18n.getMessage("many") : feeds.length.toString();
        var notification = window.webkitNotifications.createNotification(
            appGlobal.icons.defaultBig, chrome.i18n.getMessage("NewFeeds"), chrome.i18n.getMessage("YouHaveNewFeeds", count));
        notification.show();
        notifications.push(notification);
    }else{
        for(var i = 0; i < feeds.length; i++){
            var notification = window.webkitNotifications.createNotification(
                appGlobal.icons.defaultBig, chrome.i18n.getMessage("NewFeed"), feeds[i].title);

            //Open new tab on click and close notification
            notification.url = feeds[i].url;
            notification.feedId = feeds[i].id;
            notification.onclick = function(e){
                var target = e.target;
                target.cancel();
                openUrlInNewTab(target.url, true);
                if(appGlobal.options.markReadOnClick){
                    markAsRead([target.feedId]);
                }
            };
            notification.show();
            notifications.push(notification);
        }
    }

    //Hide notifications after delay
    if(appGlobal.options.hideNotificationDelay > 0){
        setTimeout(function () {
            for(i=0; i < notifications.length; i++){
                notifications[i].cancel();
            }
        }, appGlobal.options.hideNotificationDelay * 1000);
    }
}

/* Opens new tab, if tab is being opened when no active window (i.e. background mode)
 * then creates new window and adds tab in the end of it
 * url for open
 * active when is true, then tab will be active */
function openUrlInNewTab(url, active){
    chrome.windows.getAll({}, function(windows){
        if(windows.length < 1){
            chrome.windows.create({focused: true}, function(window){
                chrome.tabs.create({url: url, active: active }, function (feedTab) {
                });
            });
        }else{
            chrome.tabs.create({url: url, active: active }, function (feedTab) {
            });
        }
    });
}

/* Removes feeds from cache by feed ID */
function removeFeedFromCache(feedId){
    var indexFeedForRemove;
    for (var i = 0; i < appGlobal.cachedFeeds.length; i++) {
        if (appGlobal.cachedFeeds[i].id === feedId) {
            indexFeedForRemove = i;
            break;
        }
    }

    //Remove feed from cached feeds
    if (indexFeedForRemove !== undefined) {
        appGlobal.cachedFeeds.splice(indexFeedForRemove, 1);
    }
}

/* Returns only new feeds and set date of last feed
 * The callback parameter should specify a function that looks like this:
 * function(object newFeeds) {...};*/
function filterByNewFeeds(feeds, callback) {
    chrome.storage.local.get("lastFeedTimeTicks", function (options) {
        var lastFeedTime;

        if (options.lastFeedTimeTicks) {
            lastFeedTime = new Date(options.lastFeedTimeTicks);
        } else {
            lastFeedTime = new Date(1971, 00, 01);
        }

        var newFeeds = [];
        var maxFeedTime = lastFeedTime;

        for (var i = 0; i < feeds.length; i++) {
            if (feeds[i].date > lastFeedTime) {
                newFeeds.push(feeds[i]);
                if (feeds[i].date > maxFeedTime) {
                    maxFeedTime = feeds[i].date;
                }
            }
        }

        chrome.storage.local.set({ lastFeedTimeTicks: maxFeedTime.getTime() }, function () {
            if(typeof callback === "function"){
                callback(newFeeds);
            }
        });
    });
}

/* Runs feeds update and stores unread feeds in cache
 * Callback will be started after function complete
 * If silentUpdate is true, then notifications will not be shown
 * */
function updateFeeds(callback, silentUpdate) {
    getUnreadFeedsCount(function (unreadFeedsCount, globalCategoryId, isLoggedIn) {
        chrome.browserAction.setBadgeText({ text: String(unreadFeedsCount > 0 ? unreadFeedsCount : "")});
        appGlobal.isLoggedIn = isLoggedIn;
        if (isLoggedIn === true) {
            chrome.browserAction.setIcon({ path: appGlobal.icons.default }, function () {
            });
            fetchEntries(globalCategoryId, function (feeds, isLoggedIn) {
                appGlobal.isLoggedIn = isLoggedIn;
                if (isLoggedIn === true) {
                    appGlobal.cachedFeeds = feeds;
                    filterByNewFeeds(feeds, function(newFeeds){
                        if (appGlobal.options.showDesktopNotifications && !silentUpdate) {
                            sendDesktopNotification(newFeeds);
                        }
                    });
                } else {
                    appGlobal.cachedFeeds = [];
                }
                if (typeof callback === "function") {
                    callback();
                }
            });
        } else {
            chrome.browserAction.setIcon({ path: appGlobal.icons.inactive }, function () {
            });
            stopSchedule();
            if (typeof callback === "function") {
                callback();
            }
        }
    });
}

/* Returns feeds from the cache.
* If the cache is empty, then it will be updated before return
* forceUpdate, when is true, then cache will be updated
*/
function getFeeds(forceUpdate, callback){
     if(appGlobal.cachedFeeds.length > 0 && !forceUpdate){
         callback(appGlobal.cachedFeeds.slice(0), appGlobal.isLoggedIn);
     }else{
         updateFeeds(function(){
             callback(appGlobal.cachedFeeds.slice(0), appGlobal.isLoggedIn);
         }, true);
     }
}

/* Returns unread feeds count.
 * The callback parameter should specify a function that looks like this:
 * function(number unreadFeedsCount, string globalCategoryId, boolean isLoggedIn) {...};*/
function getUnreadFeedsCount(callback) {
    appGlobal.feedlyApiClient.request("markers/counts", {
        onSuccess: function(response){
            var unreadCounts = response.unreadcounts;
            var unreadFeedsCount = -1;
            var globalCategoryId = "";
            var isLoggedIn;
            for (var i = 0; i < unreadCounts.length; i++) {
                if (unreadFeedsCount < unreadCounts[i].count) {
                    unreadFeedsCount = unreadCounts[i].count;

                    //Search category(global or uncategorized) with max feeds
                    globalCategoryId = unreadCounts[i].id;
                }
            }
            if(typeof  callback === "function"){
                callback(Number(unreadFeedsCount), globalCategoryId, true);
            }
        },
        onAuthorizationRequired: function(){
            if(typeof  callback === "function"){
                callback(0, "", false);
            }
        }
    });
}

/* Download unread feeds.
 * categoryId is feedly category ID.
 * The callback parameter should specify a function that looks like this:
 * function(array feeds, boolean isLoggedIn) {...};*/
function fetchEntries(categoryId, callback) {
    appGlobal.feedlyApiClient.request("streams/" + encodeURIComponent(categoryId) + "/contents", {
        parameters: {
            unreadOnly: true
        },
        onSuccess: function(response){
            feeds = response.items.map(function (item) {

                var blogUrl;
                try{
                    blogUrl = item.origin.htmlUrl.match(/http(?:s)?:\/\/[^/]+/i).pop();
                }catch(exception) {
                    blogUrl = "#";
                }

                //Set content
                var content = "";
                var contentDirection = "";
                if(appGlobal.options.showFullFeedContent){
                    if(item.content !== undefined){
                        content = item.content.content;
                        contentDirection = item.content.direction;
                    }
                }
                if(content === ""){
                    if(item.summary !== undefined){
                        content = item.summary.content;
                        contentDirection = item.summary.direction;
                    }
                }

                //Set title
                var title = "";
                var titleDirection = "";
                if(item.title !== undefined){
                    if(item.title.indexOf("direction:rtl") !== -1){
                        //Feedly wraps rtl titles in div, we remove div because desktopNotification supports only text
                        title = item.title.replace(/<\/?div.*?>/gi, "");
                        titleDirection = "rtl";
                    }else{
                        title = item.title;
                    }
                }

                return {
                    //Feedly wraps rtl titles in div, we remove div because desktopNotification supports only text
                    title: title,
                    titleDirection: titleDirection,
                    url: item.alternate === undefined || item.alternate[0] === undefined ? "" : item.alternate[0].href,
                    blog: item.origin === undefined ? "" : item.origin.title,
                    blogUrl: blogUrl,
                    id: item.id,
                    content: content,
                    contentDirection: contentDirection,
                    isoDate: item.crawled === undefined ? "" : new Date(item.crawled).toISOString(),
                    date: item.crawled === undefined ? "" : new Date(item.crawled)
                };
            });
            if(typeof callback === "function"){
                callback(feeds, true);
            }
        },
        onAuthorizationRequired: function(){
            if(typeof callback === "function"){
                callback(null, false);
            }
        }
    });
}

/* Marks feed as read, remove it from the cache and decrement badge.
 * array of the ID of feeds
 * The callback parameter should specify a function that looks like this:
 * function(boolean isLoggedIn) {...};*/
function markAsRead(feedIds, callback) {
    appGlobal.feedlyApiClient.request("markers", {
        body: {
            action: "markAsRead",
            type: "entries",
            entryIds: feedIds
        },
        method: "POST",
        onSuccess: function () {
            for (var i = 0; i < feedIds.length; i++) {
                removeFeedFromCache(feedIds[i]);
            }
            chrome.browserAction.getBadgeText({}, function (feedsCount) {
                feedsCount = +feedsCount;
                if (feedsCount > 0) {
                    feedsCount -= feedIds.length;
                    chrome.browserAction.setBadgeText({ text: String(feedsCount > 0 ? feedsCount : "")});
                }
            });
            if (typeof callback === "function") {
                callback(true);
            }
        },
        onAuthorizationRequired: function () {
            if (typeof callback === "function") {
                callback(false);
            }
        }
    });
}

/* Opens feedly site and if user are logged in,
 * then read access token and stores in chrome.storage */
function getAccessToken() {
    chrome.tabs.create({url: "http://cloud.feedly.com" }, function (feedlytab) {
        chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
            if(feedlytab.id === tabId){
                //Execute code in feedly page context
                chrome.tabs.executeScript(tabId, { code: "JSON.parse(localStorage.getItem('session@cloud'))['feedlyToken']"}, function (result) {
                    if (result === undefined || result.length !== 1) {
                        return;
                    }
                    chrome.storage.sync.set({ accessToken: result[0]}, function () {
                    });
                });
            }
        });
    });
}

/* Writes all application options in chrome storage and runs callback after it */
function writeOptions(callback) {
    var options = {};
    for (var option in appGlobal.options) {
        options[option] = appGlobal.options[option];
    }
    chrome.storage.sync.set(options, function () {
        if (typeof callback === "function") {
            callback();
        }
    });
}

/* Reads all options from chrome storage and runs callback after it */
function readOptions(callback) {
    chrome.storage.sync.get(null, function (options) {
        for (var optionName in options) {
            if (typeof appGlobal.options[optionName] === "boolean") {
                appGlobal.options[optionName] = Boolean(options[optionName]);
            } else if (typeof appGlobal.options[optionName] === "number") {
                appGlobal.options[optionName] = Number(options[optionName]);
            } else {
                appGlobal.options[optionName] = options[optionName];
            }
        }
        if (typeof callback === "function") {
            callback();
        }
    });
}