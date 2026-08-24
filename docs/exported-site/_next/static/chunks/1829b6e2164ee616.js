(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,407202,(t,e,i)=>{t.e,e.exports=function(t,e,i){var n=function(t){return t.add(4-t.isoWeekday(),"day")},s=e.prototype;s.isoWeekYear=function(){return n(this).year()},s.isoWeek=function(t){if(!this.$utils().u(t))return this.add(7*(t-this.isoWeek()),"day");var e,s,r,a=n(this),o=(e=this.isoWeekYear(),r=4-(s=(this.$u?i.utc:i)().year(e).startOf("year")).isoWeekday(),s.isoWeekday()>4&&(r+=7),s.add(r,"day"));return a.diff(o,"week")+1},s.isoWeekday=function(t){return this.$utils().u(t)?this.day()||7:this.day(this.day()%7?t:t-7)};var r=s.startOf;s.startOf=function(t,e){var i=this.$utils(),n=!!i.u(e)||e;return"isoweek"===i.p(t)?n?this.date(this.date()-(this.isoWeekday()-1)).startOf("day"):this.date(this.date()-1-(this.isoWeekday()-1)+7).endOf("day"):r.bind(this)(t,e)}}},739299,(t,e,i)=>{t.e,e.exports=function(){"use strict";var t={LTS:"h:mm:ss A",LT:"h:mm A",L:"MM/DD/YYYY",LL:"MMMM D, YYYY",LLL:"MMMM D, YYYY h:mm A",LLLL:"dddd, MMMM D, YYYY h:mm A"},e=/(\[[^[]*\])|([-_:/.,()\s]+)|(A|a|Q|YYYY|YY?|ww?|MM?M?M?|Do|DD?|hh?|HH?|mm?|ss?|S{1,3}|z|ZZ?)/g,i=/\d/,n=/\d\d/,s=/\d\d?/,r=/\d*[^-_:/,()\s\d]+/,a={},o=function(t){return(t*=1)+(t>68?1900:2e3)},c=function(t){return function(e){this[t]=+e}},l=[/[+-]\d\d:?(\d\d)?|Z/,function(t){(this.zone||(this.zone={})).offset=function(t){if(!t||"Z"===t)return 0;var e=t.match(/([+-]|\d\d)/g),i=60*e[1]+(+e[2]||0);return 0===i?0:"+"===e[0]?-i:i}(t)}],d=function(t){var e=a[t];return e&&(e.indexOf?e:e.s.concat(e.f))},u=function(t,e){var i,n=a.meridiem;if(n){for(var s=1;s<=24;s+=1)if(t.indexOf(n(s,0,e))>-1){i=s>12;break}}else i=t===(e?"pm":"PM");return i},h={A:[r,function(t){this.afternoon=u(t,!1)}],a:[r,function(t){this.afternoon=u(t,!0)}],Q:[i,function(t){this.month=3*(t-1)+1}],S:[i,function(t){this.milliseconds=100*t}],SS:[n,function(t){this.milliseconds=10*t}],SSS:[/\d{3}/,function(t){this.milliseconds=+t}],s:[s,c("seconds")],ss:[s,c("seconds")],m:[s,c("minutes")],mm:[s,c("minutes")],H:[s,c("hours")],h:[s,c("hours")],HH:[s,c("hours")],hh:[s,c("hours")],D:[s,c("day")],DD:[n,c("day")],Do:[r,function(t){var e=a.ordinal,i=t.match(/\d+/);if(this.day=i[0],e)for(var n=1;n<=31;n+=1)e(n).replace(/\[|\]/g,"")===t&&(this.day=n)}],w:[s,c("week")],ww:[n,c("week")],M:[s,c("month")],MM:[n,c("month")],MMM:[r,function(t){var e=d("months"),i=(d("monthsShort")||e.map(function(t){return t.slice(0,3)})).indexOf(t)+1;if(i<1)throw Error();this.month=i%12||i}],MMMM:[r,function(t){var e=d("months").indexOf(t)+1;if(e<1)throw Error();this.month=e%12||e}],Y:[/[+-]?\d+/,c("year")],YY:[n,function(t){this.year=o(t)}],YYYY:[/\d{4}/,c("year")],Z:l,ZZ:l};return function(i,n,s){s.p.customParseFormat=!0,i&&i.parseTwoDigitYear&&(o=i.parseTwoDigitYear);var r=n.prototype,c=r.parse;r.parse=function(i){var n=i.date,r=i.utc,o=i.args;this.$u=r;var l=o[1];if("string"==typeof l){var d=!0===o[2],u=!0===o[3],m=o[2];u&&(m=o[2]),a=this.$locale(),!d&&m&&(a=s.Ls[m]),this.$d=function(i,n,s,r){try{if(["x","X"].indexOf(n)>-1)return new Date(("X"===n?1e3:1)*i);var o=(function(i){var n,s;n=i,s=a&&a.formats;for(var r=(i=n.replace(/(\[[^\]]+])|(LTS?|l{1,4}|L{1,4})/g,function(e,i,n){var r=n&&n.toUpperCase();return i||s[n]||t[n]||s[r].replace(/(\[[^\]]+])|(MMMM|MM|DD|dddd)/g,function(t,e,i){return e||i.slice(1)})})).match(e),o=r.length,c=0;c<o;c+=1){var l=r[c],d=h[l],u=d&&d[0],m=d&&d[1];r[c]=m?{regex:u,parser:m}:l.replace(/^\[|\]$/g,"")}return function(t){for(var e={},i=0,n=0;i<o;i+=1){var s=r[i];if("string"==typeof s)n+=s.length;else{var a=s.regex,c=s.parser,l=t.slice(n),d=a.exec(l)[0];c.call(e,d),t=t.replace(d,"")}}return function(t){var e=t.afternoon;if(void 0!==e){var i=t.hours;e?i<12&&(t.hours+=12):12===i&&(t.hours=0),delete t.afternoon}}(e),e}})(n)(i),c=o.year,l=o.month,d=o.day,u=o.hours,m=o.minutes,f=o.seconds,y=o.milliseconds,k=o.zone,g=o.week,p=new Date,_=d||(c||l?1:p.getDate()),T=c||p.getFullYear(),v=0;c&&!l||(v=l>0?l-1:p.getMonth());var x,b=u||0,$=m||0,w=f||0,D=y||0;return k?new Date(Date.UTC(T,v,_,b,$,w,D+60*k.offset*1e3)):s?new Date(Date.UTC(T,v,_,b,$,w,D)):(x=new Date(T,v,_,b,$,w,D),g&&(x=r(x).week(g).toDate()),x)}catch(t){return new Date("")}}(n,l,r,s),this.init(),m&&!0!==m&&(this.$L=this.locale(m).$L),(d||u)&&n!=this.format(l)&&(this.$d=new Date("")),a={}}else if(l instanceof Array)for(var f=l.length,y=1;y<=f;y+=1){o[1]=l[y-1];var k=s.apply(this,o);if(k.isValid()){this.$d=k.$d,this.$L=k.$L,this.init();break}y===f&&(this.$d=new Date(""))}else c.call(this,i)}}}()},896543,(t,e,i)=>{t.e,e.exports=function(t,e){var i=e.prototype,n=i.format;i.format=function(t){var e=this,i=this.$locale();if(!this.isValid())return n.bind(this)(t);var s=this.$utils(),r=(t||"YYYY-MM-DDTHH:mm:ssZ").replace(/\[([^\]]+)]|Q|wo|ww|w|WW|W|zzz|z|gggg|GGGG|Do|X|x|k{1,2}|S/g,function(t){switch(t){case"Q":return Math.ceil((e.$M+1)/3);case"Do":return i.ordinal(e.$D);case"gggg":return e.weekYear();case"GGGG":return e.isoWeekYear();case"wo":return i.ordinal(e.week(),"W");case"w":case"ww":return s.s(e.week(),"w"===t?1:2,"0");case"W":case"WW":return s.s(e.isoWeek(),"W"===t?1:2,"0");case"k":case"kk":return s.s(String(0===e.$H?24:e.$H),"k"===t?1:2,"0");case"X":return Math.floor(e.$d.getTime()/1e3);case"x":return e.$d.getTime();case"z":return"["+e.offsetName()+"]";case"zzz":return"["+e.offsetName("long")+"]";default:return t}});return n.bind(this)(r)}}},709964,(t,e,i)=>{t.e,e.exports=function(){"use strict";var t,e,i=/\[([^\]]+)]|Y{1,4}|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/g,n=/^(-|\+)?P(?:([-+]?[0-9,.]*)Y)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)W)?(?:([-+]?[0-9,.]*)D)?(?:T(?:([-+]?[0-9,.]*)H)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)S)?)?$/,s={years:31536e6,months:2628e6,days:864e5,hours:36e5,minutes:6e4,seconds:1e3,milliseconds:1,weeks:6048e5},r=function(t){return t instanceof u},a=function(t,e,i){return new u(t,i,e.$l)},o=function(t){return e.p(t)+"s"},c=function(t){return t<0},l=function(t){return c(t)?Math.ceil(t):Math.floor(t)},d=function(t,e){return t?c(t)?{negative:!0,format:""+Math.abs(t)+e}:{negative:!1,format:""+t+e}:{negative:!1,format:""}},u=function(){function c(t,e,i){var r=this;if(this.$d={},this.$l=i,void 0===t&&(this.$ms=0,this.parseFromMilliseconds()),e)return a(t*s[o(e)],this);if("number"==typeof t)return this.$ms=t,this.parseFromMilliseconds(),this;if("object"==typeof t)return Object.keys(t).forEach(function(e){r.$d[o(e)]=t[e]}),this.calMilliseconds(),this;if("string"==typeof t){var c=t.match(n);if(c){var l=c.slice(2).map(function(t){return null!=t?Number(t):0});return this.$d.years=l[0],this.$d.months=l[1],this.$d.weeks=l[2],this.$d.days=l[3],this.$d.hours=l[4],this.$d.minutes=l[5],this.$d.seconds=l[6],this.calMilliseconds(),this}}return this}var u=c.prototype;return u.calMilliseconds=function(){var t=this;this.$ms=Object.keys(this.$d).reduce(function(e,i){return e+(t.$d[i]||0)*s[i]},0)},u.parseFromMilliseconds=function(){var t=this.$ms;this.$d.years=l(t/31536e6),t%=31536e6,this.$d.months=l(t/2628e6),t%=2628e6,this.$d.days=l(t/864e5),t%=864e5,this.$d.hours=l(t/36e5),t%=36e5,this.$d.minutes=l(t/6e4),t%=6e4,this.$d.seconds=l(t/1e3),t%=1e3,this.$d.milliseconds=t},u.toISOString=function(){var t=d(this.$d.years,"Y"),e=d(this.$d.months,"M"),i=+this.$d.days||0;this.$d.weeks&&(i+=7*this.$d.weeks);var n=d(i,"D"),s=d(this.$d.hours,"H"),r=d(this.$d.minutes,"M"),a=this.$d.seconds||0;this.$d.milliseconds&&(a+=this.$d.milliseconds/1e3,a=Math.round(1e3*a)/1e3);var o=d(a,"S"),c=t.negative||e.negative||n.negative||s.negative||r.negative||o.negative,l=s.format||r.format||o.format?"T":"",u=(c?"-":"")+"P"+t.format+e.format+n.format+l+s.format+r.format+o.format;return"P"===u||"-P"===u?"P0D":u},u.toJSON=function(){return this.toISOString()},u.format=function(t){var n={Y:this.$d.years,YY:e.s(this.$d.years,2,"0"),YYYY:e.s(this.$d.years,4,"0"),M:this.$d.months,MM:e.s(this.$d.months,2,"0"),D:this.$d.days,DD:e.s(this.$d.days,2,"0"),H:this.$d.hours,HH:e.s(this.$d.hours,2,"0"),m:this.$d.minutes,mm:e.s(this.$d.minutes,2,"0"),s:this.$d.seconds,ss:e.s(this.$d.seconds,2,"0"),SSS:e.s(this.$d.milliseconds,3,"0")};return(t||"YYYY-MM-DDTHH:mm:ss").replace(i,function(t,e){return e||String(n[t])})},u.as=function(t){return this.$ms/s[o(t)]},u.get=function(t){var e=this.$ms,i=o(t);return"milliseconds"===i?e%=1e3:e="weeks"===i?l(e/s[i]):this.$d[i],e||0},u.add=function(t,e,i){var n;return n=e?t*s[o(e)]:r(t)?t.$ms:a(t,this).$ms,a(this.$ms+n*(i?-1:1),this)},u.subtract=function(t,e){return this.add(t,e,!0)},u.locale=function(t){var e=this.clone();return e.$l=t,e},u.clone=function(){return a(this.$ms,this)},u.humanize=function(e){return t().add(this.$ms,"ms").locale(this.$l).fromNow(!e)},u.valueOf=function(){return this.asMilliseconds()},u.milliseconds=function(){return this.get("milliseconds")},u.asMilliseconds=function(){return this.as("milliseconds")},u.seconds=function(){return this.get("seconds")},u.asSeconds=function(){return this.as("seconds")},u.minutes=function(){return this.get("minutes")},u.asMinutes=function(){return this.as("minutes")},u.hours=function(){return this.get("hours")},u.asHours=function(){return this.as("hours")},u.days=function(){return this.get("days")},u.asDays=function(){return this.as("days")},u.weeks=function(){return this.get("weeks")},u.asWeeks=function(){return this.as("weeks")},u.months=function(){return this.get("months")},u.asMonths=function(){return this.as("months")},u.years=function(){return this.get("years")},u.asYears=function(){return this.as("years")},c}(),h=function(t,e,i){return t.add(e.years()*i,"y").add(e.months()*i,"M").add(e.days()*i,"d").add(e.hours()*i,"h").add(e.minutes()*i,"m").add(e.seconds()*i,"s").add(e.milliseconds()*i,"ms")};return function(i,n,s){t=s,e=s().$utils(),s.duration=function(t,e){return a(t,{$l:s.locale()},e)},s.isDuration=r;var o=n.prototype.add,c=n.prototype.subtract;n.prototype.add=function(t,e){return r(t)?h(this,t,1):o.bind(this)(t,e)},n.prototype.subtract=function(t,e){return r(t)?h(this,t,-1):c.bind(this)(t,e)}}}()},13976,t=>{"use strict";t.s(["diagram",()=>tq]);var e,i,n,s=t.i(729432),r=t.i(96977),a=t.i(171206),o=t.i(139941),c=t.i(152418),l=t.i(407202),d=t.i(739299),u=t.i(896543),h=t.i(709964);t.i(947716);var m=t.i(723685),f=t.i(899045),y=t.i(997253),k=t.i(927622),g=t.i(282803),p=t.i(729418),_=t.i(677803),T=t.i(894496),v=t.i(672294),x=t.i(66532),b=t.i(802991),$=t.i(173337),w=t.i(718416),D=t.i(212644),S=t.i(770853),C=function(){var t=(0,a.__name)(function(t,e,i,n){for(i=i||{},n=t.length;n--;i[t[n]]=e);return i},"o"),e=[6,8,10,12,13,14,15,16,17,18,20,21,22,23,24,25,26,27,28,29,30,31,33,35,36,38,40],i=[1,26],n=[1,27],s=[1,28],r=[1,29],o=[1,30],c=[1,31],l=[1,32],d=[1,33],u=[1,34],h=[1,9],m=[1,10],f=[1,11],y=[1,12],k=[1,13],g=[1,14],p=[1,15],_=[1,16],T=[1,19],v=[1,20],x=[1,21],b=[1,22],$=[1,23],w=[1,25],D=[1,35],S={trace:(0,a.__name)(function(){},"trace"),yy:{},symbols_:{error:2,start:3,gantt:4,document:5,EOF:6,line:7,SPACE:8,statement:9,NL:10,weekday:11,weekday_monday:12,weekday_tuesday:13,weekday_wednesday:14,weekday_thursday:15,weekday_friday:16,weekday_saturday:17,weekday_sunday:18,weekend:19,weekend_friday:20,weekend_saturday:21,dateFormat:22,inclusiveEndDates:23,topAxis:24,axisFormat:25,tickInterval:26,excludes:27,includes:28,todayMarker:29,title:30,acc_title:31,acc_title_value:32,acc_descr:33,acc_descr_value:34,acc_descr_multiline_value:35,section:36,clickStatement:37,taskTxt:38,taskData:39,click:40,callbackname:41,callbackargs:42,href:43,clickStatementDebug:44,$accept:0,$end:1},terminals_:{2:"error",4:"gantt",6:"EOF",8:"SPACE",10:"NL",12:"weekday_monday",13:"weekday_tuesday",14:"weekday_wednesday",15:"weekday_thursday",16:"weekday_friday",17:"weekday_saturday",18:"weekday_sunday",20:"weekend_friday",21:"weekend_saturday",22:"dateFormat",23:"inclusiveEndDates",24:"topAxis",25:"axisFormat",26:"tickInterval",27:"excludes",28:"includes",29:"todayMarker",30:"title",31:"acc_title",32:"acc_title_value",33:"acc_descr",34:"acc_descr_value",35:"acc_descr_multiline_value",36:"section",38:"taskTxt",39:"taskData",40:"click",41:"callbackname",42:"callbackargs",43:"href"},productions_:[0,[3,3],[5,0],[5,2],[7,2],[7,1],[7,1],[7,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[19,1],[19,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,2],[9,2],[9,1],[9,1],[9,1],[9,2],[37,2],[37,3],[37,3],[37,4],[37,3],[37,4],[37,2],[44,2],[44,3],[44,3],[44,4],[44,3],[44,4],[44,2]],performAction:(0,a.__name)(function(t,e,i,n,s,r,a){var o=r.length-1;switch(s){case 1:return r[o-1];case 2:case 6:case 7:this.$=[];break;case 3:r[o-1].push(r[o]),this.$=r[o-1];break;case 4:case 5:this.$=r[o];break;case 8:n.setWeekday("monday");break;case 9:n.setWeekday("tuesday");break;case 10:n.setWeekday("wednesday");break;case 11:n.setWeekday("thursday");break;case 12:n.setWeekday("friday");break;case 13:n.setWeekday("saturday");break;case 14:n.setWeekday("sunday");break;case 15:n.setWeekend("friday");break;case 16:n.setWeekend("saturday");break;case 17:n.setDateFormat(r[o].substr(11)),this.$=r[o].substr(11);break;case 18:n.enableInclusiveEndDates(),this.$=r[o].substr(18);break;case 19:n.TopAxis(),this.$=r[o].substr(8);break;case 20:n.setAxisFormat(r[o].substr(11)),this.$=r[o].substr(11);break;case 21:n.setTickInterval(r[o].substr(13)),this.$=r[o].substr(13);break;case 22:n.setExcludes(r[o].substr(9)),this.$=r[o].substr(9);break;case 23:n.setIncludes(r[o].substr(9)),this.$=r[o].substr(9);break;case 24:n.setTodayMarker(r[o].substr(12)),this.$=r[o].substr(12);break;case 27:n.setDiagramTitle(r[o].substr(6)),this.$=r[o].substr(6);break;case 28:this.$=r[o].trim(),n.setAccTitle(this.$);break;case 29:case 30:this.$=r[o].trim(),n.setAccDescription(this.$);break;case 31:n.addSection(r[o].substr(8)),this.$=r[o].substr(8);break;case 33:n.addTask(r[o-1],r[o]),this.$="task";break;case 34:this.$=r[o-1],n.setClickEvent(r[o-1],r[o],null);break;case 35:this.$=r[o-2],n.setClickEvent(r[o-2],r[o-1],r[o]);break;case 36:this.$=r[o-2],n.setClickEvent(r[o-2],r[o-1],null),n.setLink(r[o-2],r[o]);break;case 37:this.$=r[o-3],n.setClickEvent(r[o-3],r[o-2],r[o-1]),n.setLink(r[o-3],r[o]);break;case 38:this.$=r[o-2],n.setClickEvent(r[o-2],r[o],null),n.setLink(r[o-2],r[o-1]);break;case 39:this.$=r[o-3],n.setClickEvent(r[o-3],r[o-1],r[o]),n.setLink(r[o-3],r[o-2]);break;case 40:this.$=r[o-1],n.setLink(r[o-1],r[o]);break;case 41:case 47:this.$=r[o-1]+" "+r[o];break;case 42:case 43:case 45:this.$=r[o-2]+" "+r[o-1]+" "+r[o];break;case 44:case 46:this.$=r[o-3]+" "+r[o-2]+" "+r[o-1]+" "+r[o]}},"anonymous"),table:[{3:1,4:[1,2]},{1:[3]},t(e,[2,2],{5:3}),{6:[1,4],7:5,8:[1,6],9:7,10:[1,8],11:17,12:i,13:n,14:s,15:r,16:o,17:c,18:l,19:18,20:d,21:u,22:h,23:m,24:f,25:y,26:k,27:g,28:p,29:_,30:T,31:v,33:x,35:b,36:$,37:24,38:w,40:D},t(e,[2,7],{1:[2,1]}),t(e,[2,3]),{9:36,11:17,12:i,13:n,14:s,15:r,16:o,17:c,18:l,19:18,20:d,21:u,22:h,23:m,24:f,25:y,26:k,27:g,28:p,29:_,30:T,31:v,33:x,35:b,36:$,37:24,38:w,40:D},t(e,[2,5]),t(e,[2,6]),t(e,[2,17]),t(e,[2,18]),t(e,[2,19]),t(e,[2,20]),t(e,[2,21]),t(e,[2,22]),t(e,[2,23]),t(e,[2,24]),t(e,[2,25]),t(e,[2,26]),t(e,[2,27]),{32:[1,37]},{34:[1,38]},t(e,[2,30]),t(e,[2,31]),t(e,[2,32]),{39:[1,39]},t(e,[2,8]),t(e,[2,9]),t(e,[2,10]),t(e,[2,11]),t(e,[2,12]),t(e,[2,13]),t(e,[2,14]),t(e,[2,15]),t(e,[2,16]),{41:[1,40],43:[1,41]},t(e,[2,4]),t(e,[2,28]),t(e,[2,29]),t(e,[2,33]),t(e,[2,34],{42:[1,42],43:[1,43]}),t(e,[2,40],{41:[1,44]}),t(e,[2,35],{43:[1,45]}),t(e,[2,36]),t(e,[2,38],{42:[1,46]}),t(e,[2,37]),t(e,[2,39])],defaultActions:{},parseError:(0,a.__name)(function(t,e){if(e.recoverable)this.trace(t);else{var i=Error(t);throw i.hash=e,i}},"parseError"),parse:(0,a.__name)(function(t){var e=this,i=[0],n=[],s=[null],r=[],o=this.table,c="",l=0,d=0,u=0,h=r.slice.call(arguments,1),m=Object.create(this.lexer),f={};for(var y in this.yy)Object.prototype.hasOwnProperty.call(this.yy,y)&&(f[y]=this.yy[y]);m.setInput(t,f),f.lexer=m,f.parser=this,void 0===m.yylloc&&(m.yylloc={});var k=m.yylloc;r.push(k);var g=m.options&&m.options.ranges;function p(){var t;return"number"!=typeof(t=n.pop()||m.lex()||1)&&(t instanceof Array&&(t=(n=t).pop()),t=e.symbols_[t]||t),t}"function"==typeof f.parseError?this.parseError=f.parseError:this.parseError=Object.getPrototypeOf(this).parseError,(0,a.__name)(function(t){i.length=i.length-2*t,s.length=s.length-t,r.length=r.length-t},"popStack"),(0,a.__name)(p,"lex");for(var _,T,v,x,b,$,w,D,S,C={};;){if(v=i[i.length-1],this.defaultActions[v]?x=this.defaultActions[v]:(null==_&&(_=p()),x=o[v]&&o[v][_]),void 0===x||!x.length||!x[0]){var M="";for($ in S=[],o[v])this.terminals_[$]&&$>2&&S.push("'"+this.terminals_[$]+"'");M=m.showPosition?"Parse error on line "+(l+1)+":\n"+m.showPosition()+"\nExpecting "+S.join(", ")+", got '"+(this.terminals_[_]||_)+"'":"Parse error on line "+(l+1)+": Unexpected "+(1==_?"end of input":"'"+(this.terminals_[_]||_)+"'"),this.parseError(M,{text:m.match,token:this.terminals_[_]||_,line:m.yylineno,loc:k,expected:S})}if(x[0]instanceof Array&&x.length>1)throw Error("Parse Error: multiple actions possible at state: "+v+", token: "+_);switch(x[0]){case 1:i.push(_),s.push(m.yytext),r.push(m.yylloc),i.push(x[1]),_=null,T?(_=T,T=null):(d=m.yyleng,c=m.yytext,l=m.yylineno,k=m.yylloc,u>0&&u--);break;case 2:if(w=this.productions_[x[1]][1],C.$=s[s.length-w],C._$={first_line:r[r.length-(w||1)].first_line,last_line:r[r.length-1].last_line,first_column:r[r.length-(w||1)].first_column,last_column:r[r.length-1].last_column},g&&(C._$.range=[r[r.length-(w||1)].range[0],r[r.length-1].range[1]]),void 0!==(b=this.performAction.apply(C,[c,d,l,f,x[1],s,r].concat(h))))return b;w&&(i=i.slice(0,-1*w*2),s=s.slice(0,-1*w),r=r.slice(0,-1*w)),i.push(this.productions_[x[1]][0]),s.push(C.$),r.push(C._$),D=o[i[i.length-2]][i[i.length-1]],i.push(D);break;case 3:return!0}}return!0},"parse")};function C(){this.yy={}}return S.lexer={EOF:1,parseError:(0,a.__name)(function(t,e){if(this.yy.parser)this.yy.parser.parseError(t,e);else throw Error(t)},"parseError"),setInput:(0,a.__name)(function(t,e){return this.yy=e||this.yy||{},this._input=t,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:(0,a.__name)(function(){var t=this._input[0];return this.yytext+=t,this.yyleng++,this.offset++,this.match+=t,this.matched+=t,t.match(/(?:\r\n?|\n).*/g)?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),t},"input"),unput:(0,a.__name)(function(t){var e=t.length,i=t.split(/(?:\r\n?|\n)/g);this._input=t+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-e),this.offset-=e;var n=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),i.length-1&&(this.yylineno-=i.length-1);var s=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:i?(i.length===n.length?this.yylloc.first_column:0)+n[n.length-i.length].length-i[0].length:this.yylloc.first_column-e},this.options.ranges&&(this.yylloc.range=[s[0],s[0]+this.yyleng-e]),this.yyleng=this.yytext.length,this},"unput"),more:(0,a.__name)(function(){return this._more=!0,this},"more"),reject:(0,a.__name)(function(){return this.options.backtrack_lexer?(this._backtrack=!0,this):this.parseError("Lexical error on line "+(this.yylineno+1)+". You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).\n"+this.showPosition(),{text:"",token:null,line:this.yylineno})},"reject"),less:(0,a.__name)(function(t){this.unput(this.match.slice(t))},"less"),pastInput:(0,a.__name)(function(){var t=this.matched.substr(0,this.matched.length-this.match.length);return(t.length>20?"...":"")+t.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:(0,a.__name)(function(){var t=this.match;return t.length<20&&(t+=this._input.substr(0,20-t.length)),(t.substr(0,20)+(t.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:(0,a.__name)(function(){var t=this.pastInput(),e=Array(t.length+1).join("-");return t+this.upcomingInput()+"\n"+e+"^"},"showPosition"),test_match:(0,a.__name)(function(t,e){var i,n,s;if(this.options.backtrack_lexer&&(s={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(s.yylloc.range=this.yylloc.range.slice(0))),(n=t[0].match(/(?:\r\n?|\n).*/g))&&(this.yylineno+=n.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:n?n[n.length-1].length-n[n.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+t[0].length},this.yytext+=t[0],this.match+=t[0],this.matches=t,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(t[0].length),this.matched+=t[0],i=this.performAction.call(this,this.yy,this,e,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),i)return i;if(this._backtrack)for(var r in s)this[r]=s[r];return!1},"test_match"),next:(0,a.__name)(function(){if(this.done)return this.EOF;this._input||(this.done=!0),this._more||(this.yytext="",this.match="");for(var t,e,i,n,s=this._currentRules(),r=0;r<s.length;r++)if((i=this._input.match(this.rules[s[r]]))&&(!e||i[0].length>e[0].length)){if(e=i,n=r,this.options.backtrack_lexer){if(!1!==(t=this.test_match(i,s[r])))return t;if(!this._backtrack)return!1;e=!1;continue}if(!this.options.flex)break}return e?!1!==(t=this.test_match(e,s[n]))&&t:""===this._input?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+". Unrecognized text.\n"+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:(0,a.__name)(function(){var t=this.next();return t||this.lex()},"lex"),begin:(0,a.__name)(function(t){this.conditionStack.push(t)},"begin"),popState:(0,a.__name)(function(){return this.conditionStack.length-1>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:(0,a.__name)(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:(0,a.__name)(function(t){return(t=this.conditionStack.length-1-Math.abs(t||0))>=0?this.conditionStack[t]:"INITIAL"},"topState"),pushState:(0,a.__name)(function(t){this.begin(t)},"pushState"),stateStackSize:(0,a.__name)(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:(0,a.__name)(function(t,e,i,n){switch(i){case 0:return this.begin("open_directive"),"open_directive";case 1:return this.begin("acc_title"),31;case 2:return this.popState(),"acc_title_value";case 3:return this.begin("acc_descr"),33;case 4:return this.popState(),"acc_descr_value";case 5:this.begin("acc_descr_multiline");break;case 6:case 15:case 18:case 21:case 24:this.popState();break;case 7:return"acc_descr_multiline_value";case 8:case 9:case 10:case 12:case 13:break;case 11:return 10;case 14:this.begin("href");break;case 16:return 43;case 17:this.begin("callbackname");break;case 19:this.popState(),this.begin("callbackargs");break;case 20:return 41;case 22:return 42;case 23:this.begin("click");break;case 25:return 40;case 26:return 4;case 27:return 22;case 28:return 23;case 29:return 24;case 30:return 25;case 31:return 26;case 32:return 28;case 33:return 27;case 34:return 29;case 35:return 12;case 36:return 13;case 37:return 14;case 38:return 15;case 39:return 16;case 40:return 17;case 41:return 18;case 42:return 20;case 43:return 21;case 44:return"date";case 45:return 30;case 46:return"accDescription";case 47:return 36;case 48:return 38;case 49:return 39;case 50:return":";case 51:return 6;case 52:return"INVALID"}},"anonymous"),rules:[/^(?:%%\{)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:%%(?!\{)*[^\n]*)/i,/^(?:[^\}]%%*[^\n]*)/i,/^(?:%%*[^\n]*[\n]*)/i,/^(?:[\n]+)/i,/^(?:\s+)/i,/^(?:%[^\n]*)/i,/^(?:href[\s]+["])/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:call[\s]+)/i,/^(?:\([\s]*\))/i,/^(?:\()/i,/^(?:[^(]*)/i,/^(?:\))/i,/^(?:[^)]*)/i,/^(?:click[\s]+)/i,/^(?:[\s\n])/i,/^(?:[^\s\n]*)/i,/^(?:gantt\b)/i,/^(?:dateFormat\s[^#\n;]+)/i,/^(?:inclusiveEndDates\b)/i,/^(?:topAxis\b)/i,/^(?:axisFormat\s[^#\n;]+)/i,/^(?:tickInterval\s[^#\n;]+)/i,/^(?:includes\s[^#\n;]+)/i,/^(?:excludes\s[^#\n;]+)/i,/^(?:todayMarker\s[^\n;]+)/i,/^(?:weekday\s+monday\b)/i,/^(?:weekday\s+tuesday\b)/i,/^(?:weekday\s+wednesday\b)/i,/^(?:weekday\s+thursday\b)/i,/^(?:weekday\s+friday\b)/i,/^(?:weekday\s+saturday\b)/i,/^(?:weekday\s+sunday\b)/i,/^(?:weekend\s+friday\b)/i,/^(?:weekend\s+saturday\b)/i,/^(?:\d\d\d\d-\d\d-\d\d\b)/i,/^(?:title\s[^\n]+)/i,/^(?:accDescription\s[^#\n;]+)/i,/^(?:section\s[^\n]+)/i,/^(?:[^:\n]+)/i,/^(?::[^#\n;]+)/i,/^(?::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{acc_descr_multiline:{rules:[6,7],inclusive:!1},acc_descr:{rules:[4],inclusive:!1},acc_title:{rules:[2],inclusive:!1},callbackargs:{rules:[21,22],inclusive:!1},callbackname:{rules:[18,19,20],inclusive:!1},href:{rules:[15,16],inclusive:!1},click:{rules:[24,25],inclusive:!1},INITIAL:{rules:[0,1,3,5,8,9,10,11,12,13,14,17,23,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52],inclusive:!0}}},(0,a.__name)(C,"Parser"),C.prototype=S,S.Parser=C,new C}();C.parser=C,c.default.extend(l.default),c.default.extend(d.default),c.default.extend(u.default);var M={friday:5,saturday:6},E="",Y="",O=void 0,L="",A=[],I=[],F=new Map,W=[],P=[],H="",z="",B=["active","done","crit","milestone","vert"],N=[],R="",j=!1,G=!1,U="sunday",Z="saturday",V=0,q=(0,a.__name)(function(){W=[],P=[],H="",N=[],tC=0,e=void 0,i=void 0,tO=[],E="",Y="",z="",O=void 0,L="",A=[],I=[],j=!1,G=!1,V=0,F=new Map,R="",(0,r.clear)(),U="sunday",Z="saturday"},"clear"),X=(0,a.__name)(function(t){R=t},"setDiagramId"),Q=(0,a.__name)(function(t){Y=t},"setAxisFormat"),K=(0,a.__name)(function(){return Y},"getAxisFormat"),J=(0,a.__name)(function(t){O=t},"setTickInterval"),tt=(0,a.__name)(function(){return O},"getTickInterval"),te=(0,a.__name)(function(t){L=t},"setTodayMarker"),ti=(0,a.__name)(function(){return L},"getTodayMarker"),tn=(0,a.__name)(function(t){E=t},"setDateFormat"),ts=(0,a.__name)(function(){j=!0},"enableInclusiveEndDates"),tr=(0,a.__name)(function(){return j},"endDatesAreInclusive"),ta=(0,a.__name)(function(){G=!0},"enableTopAxis"),to=(0,a.__name)(function(){return G},"topAxisEnabled"),tc=(0,a.__name)(function(t){z=t},"setDisplayMode"),tl=(0,a.__name)(function(){return z},"getDisplayMode"),td=(0,a.__name)(function(){return E},"getDateFormat"),tu=(0,a.__name)(function(t){A=t.toLowerCase().split(/[\s,]+/)},"setIncludes"),th=(0,a.__name)(function(){return A},"getIncludes"),tm=(0,a.__name)(function(t){I=t.toLowerCase().split(/[\s,]+/)},"setExcludes"),tf=(0,a.__name)(function(){return I},"getExcludes"),ty=(0,a.__name)(function(){return F},"getLinks"),tk=(0,a.__name)(function(t){H=t,W.push(t)},"addSection"),tg=(0,a.__name)(function(){return W},"getSections"),tp=(0,a.__name)(function(){let t=tW(),e=0;for(;!t&&e<10;)t=tW(),e++;return P=tO},"getTasks"),t_=(0,a.__name)(function(t,e,i,n){let s=t.format(e.trim()),r=t.format("YYYY-MM-DD");return!(n.includes(s)||n.includes(r))&&(!!(i.includes("weekends")&&(t.isoWeekday()===M[Z]||t.isoWeekday()===M[Z]+1)||i.includes(t.format("dddd").toLowerCase()))||i.includes(s)||i.includes(r))},"isInvalidDate"),tT=(0,a.__name)(function(t){U=t},"setWeekday"),tv=(0,a.__name)(function(){return U},"getWeekday"),tx=(0,a.__name)(function(t){Z=t},"setWeekend"),tb=(0,a.__name)(function(t,e,i,n){let s;if(!i.length||t.manualEndTime)return;let[r,a]=t$(s=(s=t.startTime instanceof Date?(0,c.default)(t.startTime):(0,c.default)(t.startTime,e,!0)).add(1,"d"),t.endTime instanceof Date?(0,c.default)(t.endTime):(0,c.default)(t.endTime,e,!0),e,i,n);t.endTime=r.toDate(),t.renderEndTime=a},"checkTaskDates"),t$=(0,a.__name)(function(t,e,i,n,s){let r=!1,a=null;for(;t<=e;)r||(a=e.toDate()),(r=t_(t,i,n,s))&&(e=e.add(1,"d")),t=t.add(1,"d");return[e,a]},"fixTaskDates"),tw=(0,a.__name)(function(t,e,i){if(i=i.trim(),(0,a.__name)(t=>{let e=t.trim();return"x"===e||"X"===e},"isTimestampFormat")(e)&&/^\d+$/.test(i))return new Date(Number(i));let n=/^after\s+(?<ids>[\d\w- ]+)/.exec(i);if(null!==n){let t=null;for(let e of n.groups.ids.split(" ")){let i=tI(e);void 0!==i&&(!t||i.endTime>t.endTime)&&(t=i)}if(t)return t.endTime;let e=new Date;return e.setHours(0,0,0,0),e}let s=(0,c.default)(i,e.trim(),!0);if(s.isValid())return s.toDate();{a.log.debug("Invalid date:"+i),a.log.debug("With date format:"+e.trim());let t=new Date(i);if(void 0===t||isNaN(t.getTime())||-1e4>t.getFullYear()||t.getFullYear()>1e4)throw Error("Invalid date:"+i);return t}},"getStartDate"),tD=(0,a.__name)(function(t){let e=/^(\d+(?:\.\d+)?)([Mdhmswy]|ms)$/.exec(t.trim());return null!==e?[Number.parseFloat(e[1]),e[2]]:[NaN,"ms"]},"parseDuration"),tS=(0,a.__name)(function(t,e,i,n=!1){i=i.trim();let s=/^until\s+(?<ids>[\d\w- ]+)/.exec(i);if(null!==s){let t=null;for(let e of s.groups.ids.split(" ")){let i=tI(e);void 0!==i&&(!t||i.startTime<t.startTime)&&(t=i)}if(t)return t.startTime;let e=new Date;return e.setHours(0,0,0,0),e}let r=(0,c.default)(i,e.trim(),!0);if(r.isValid())return n&&(r=r.add(1,"d")),r.toDate();let a=(0,c.default)(t),[o,l]=tD(i);if(!Number.isNaN(o)){let t=a.add(o,l);t.isValid()&&(a=t)}return a.toDate()},"getEndDate"),tC=0,tM=(0,a.__name)(function(t){return void 0===t?"task"+(tC+=1):t},"parseId"),tE=(0,a.__name)(function(t,e){let i=(":"===e.substr(0,1)?e.substr(1,e.length):e).split(","),n={};tG(i,n,B);for(let t=0;t<i.length;t++)i[t]=i[t].trim();let s="";switch(i.length){case 1:n.id=tM(),n.startTime=t.endTime,s=i[0];break;case 2:n.id=tM(),n.startTime=tw(void 0,E,i[0]),s=i[1];break;case 3:n.id=tM(i[0]),n.startTime=tw(void 0,E,i[1]),s=i[2]}return s&&(n.endTime=tS(n.startTime,E,s,j),n.manualEndTime=(0,c.default)(s,"YYYY-MM-DD",!0).isValid(),tb(n,E,I,A)),n},"compileData"),tY=(0,a.__name)(function(t,e){let i=(":"===e.substr(0,1)?e.substr(1,e.length):e).split(","),n={};tG(i,n,B);for(let t=0;t<i.length;t++)i[t]=i[t].trim();switch(i.length){case 1:n.id=tM(),n.startTime={type:"prevTaskEnd",id:t},n.endTime={data:i[0]};break;case 2:n.id=tM(),n.startTime={type:"getStartDate",startData:i[0]},n.endTime={data:i[1]};break;case 3:n.id=tM(i[0]),n.startTime={type:"getStartDate",startData:i[1]},n.endTime={data:i[2]}}return n},"parseData"),tO=[],tL={},tA=(0,a.__name)(function(t,e){let n={section:H,type:H,processed:!1,manualEndTime:!1,renderEndTime:null,raw:{data:e},task:t,classes:[]},s=tY(i,e);n.raw.startTime=s.startTime,n.raw.endTime=s.endTime,n.id=s.id,n.prevTaskId=i,n.active=s.active,n.done=s.done,n.crit=s.crit,n.milestone=s.milestone,n.vert=s.vert,n.order=V,V++;let r=tO.push(n);i=n.id,tL[n.id]=r-1},"addTask"),tI=(0,a.__name)(function(t){return tO[tL[t]]},"findTaskById"),tF=(0,a.__name)(function(t,i){let n={section:H,type:H,description:t,task:t,classes:[]},s=tE(e,i);n.startTime=s.startTime,n.endTime=s.endTime,n.id=s.id,n.active=s.active,n.done=s.done,n.crit=s.crit,n.milestone=s.milestone,n.vert=s.vert,e=n,P.push(n)},"addTaskOrg"),tW=(0,a.__name)(function(){let t=(0,a.__name)(function(t){let e=tO[t],i="";switch(tO[t].raw.startTime.type){case"prevTaskEnd":{let t=tI(e.prevTaskId);e.startTime=t.endTime;break}case"getStartDate":(i=tw(void 0,E,tO[t].raw.startTime.startData))&&(tO[t].startTime=i)}return tO[t].startTime&&(tO[t].endTime=tS(tO[t].startTime,E,tO[t].raw.endTime.data,j),tO[t].endTime&&(tO[t].processed=!0,tO[t].manualEndTime=(0,c.default)(tO[t].raw.endTime.data,"YYYY-MM-DD",!0).isValid(),tb(tO[t],E,I,A))),tO[t].processed},"compileTask"),e=!0;for(let[i,n]of tO.entries())t(i),e=e&&n.processed;return e},"compileTasks"),tP=(0,a.__name)(function(t,e){let i=e;"loose"!==(0,r.getConfig2)().securityLevel&&(i=(0,o.sanitizeUrl)(e)),t.split(",").forEach(function(t){void 0!==tI(t)&&(tB(t,()=>{window.open(i,"_self")}),F.set(t,i))}),tH(t,"clickable")},"setLink"),tH=(0,a.__name)(function(t,e){t.split(",").forEach(function(t){let i=tI(t);void 0!==i&&i.classes.push(e)})},"setClass"),tz=(0,a.__name)(function(t,e,i){if("loose"!==(0,r.getConfig2)().securityLevel||void 0===e)return;let n=[];if("string"==typeof i){n=i.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);for(let t=0;t<n.length;t++){let e=n[t].trim();e.startsWith('"')&&e.endsWith('"')&&(e=e.substr(1,e.length-2)),n[t]=e}}0===n.length&&n.push(t),void 0!==tI(t)&&tB(t,()=>{s.utils_default.runFunc(e,...n)})},"setClickFun"),tB=(0,a.__name)(function(t,e){N.push(function(){let i=R?`${R}-${t}`:t,n=document.querySelector(`[id="${i}"]`);null!==n&&n.addEventListener("click",function(){e()})},function(){let i=R?`${R}-${t}`:t,n=document.querySelector(`[id="${i}-text"]`);null!==n&&n.addEventListener("click",function(){e()})})},"pushFun"),tN=(0,a.__name)(function(t,e,i){t.split(",").forEach(function(t){tz(t,e,i)}),tH(t,"clickable")},"setClickEvent"),tR=(0,a.__name)(function(t){N.forEach(function(e){e(t)})},"bindFunctions"),tj={getConfig:(0,a.__name)(()=>(0,r.getConfig2)().gantt,"getConfig"),clear:q,setDateFormat:tn,getDateFormat:td,enableInclusiveEndDates:ts,endDatesAreInclusive:tr,enableTopAxis:ta,topAxisEnabled:to,setAxisFormat:Q,getAxisFormat:K,setTickInterval:J,getTickInterval:tt,setTodayMarker:te,getTodayMarker:ti,setAccTitle:r.setAccTitle,getAccTitle:r.getAccTitle,setDiagramTitle:r.setDiagramTitle,getDiagramTitle:r.getDiagramTitle,setDiagramId:X,setDisplayMode:tc,getDisplayMode:tl,setAccDescription:r.setAccDescription,getAccDescription:r.getAccDescription,addSection:tk,getSections:tg,getTasks:tp,addTask:tA,findTaskById:tI,addTaskOrg:tF,setIncludes:tu,getIncludes:th,setExcludes:tm,getExcludes:tf,setClickEvent:tN,setLink:tP,getLinks:ty,bindFunctions:tR,parseDuration:tD,isInvalidDate:t_,setWeekday:tT,getWeekday:tv,setWeekend:tx};function tG(t,e,i){let n=!0;for(;n;)n=!1,i.forEach(function(i){let s=RegExp("^\\s*"+i+"\\s*$");t[0].match(s)&&(e[i]=!0,t.shift(1),n=!0)})}(0,a.__name)(tG,"getTaskTags"),c.default.extend(h.default);var tU=(0,a.__name)(function(){a.log.debug("Something is calling, setConf, remove the call")},"setConf"),tZ={monday:D.timeMonday,tuesday:D.timeTuesday,wednesday:D.timeWednesday,thursday:D.timeThursday,friday:D.timeFriday,saturday:D.timeSaturday,sunday:D.timeSunday},tV=(0,a.__name)((t,e)=>{let i=[...t].map(()=>-1/0),n=[...t].sort((t,e)=>t.startTime-e.startTime||t.order-e.order),s=0;for(let t of n)for(let n=0;n<i.length;n++)if(t.startTime>=i[n]){i[n]=t.endTime,t.order=n+e,n>s&&(s=n);break}return s},"getMaxIntersections"),tq={parser:C,db:tj,renderer:{setConf:tU,draw:(0,a.__name)(function(t,e,i,s){let o,l=(0,r.getConfig2)().gantt;s.db.setDiagramId(e);let d=(0,r.getConfig2)().securityLevel;"sandbox"===d&&(o=(0,m.select)("#i"+e));let u="sandbox"===d?(0,m.select)(o.nodes()[0].contentDocument.body):(0,m.select)("body"),h="sandbox"===d?o.nodes()[0].contentDocument:document,D=h.getElementById(e);void 0===(n=D.parentElement.offsetWidth)&&(n=1200),void 0!==l.useWidth&&(n=l.useWidth);let C=s.db.getTasks(),M=[];for(let t of C)M.push(t.type);M=N(M);let E={},Y=2*l.topPadding;if("compact"===s.db.getDisplayMode()||"compact"===l.displayMode){let t={};for(let e of C)void 0===t[e.section]?t[e.section]=[e]:t[e.section].push(e);let e=0;for(let i of Object.keys(t)){let n=tV(t[i],e)+1;e+=n,Y+=n*(l.barHeight+l.barGap),E[i]=n}}else for(let t of(Y+=C.length*(l.barHeight+l.barGap),M))E[t]=C.filter(e=>e.type===t).length;D.setAttribute("viewBox","0 0 "+n+" "+Y);let O=u.select(`[id="${e}"]`),L=(0,f.scaleTime)().domain([(0,y.min)(C,function(t){return t.startTime}),(0,k.max)(C,function(t){return t.endTime})]).rangeRound([0,n-l.leftPadding-l.rightPadding]);function A(t,e){let i=t.startTime,n=e.startTime,s=0;return i>n?s=1:i<n&&(s=-1),s}function I(t,e,i){let n=l.barHeight,r=n+l.barGap,a=l.topPadding,o=l.leftPadding,c=(0,g.scaleLinear)().domain([0,M.length]).range(["#00B9FA","#F95002"]).interpolate(p.interpolateHcl);W(r,a,o,e,i,t,s.db.getExcludes(),s.db.getIncludes()),H(o,a,e,i),F(t,r,a,o,n,c,e,i),z(r,a,o,n,c),B(o,a,e,i)}function F(t,i,n,a,o,c,d){t.sort((t,e)=>t.vert===e.vert?0:t.vert?1:-1);let u=[...new Set(t.map(t=>t.order))].map(e=>t.find(t=>t.order===e));O.append("g").selectAll("rect").data(u).enter().append("rect").attr("x",0).attr("y",function(t,e){return t.order*i+n-2}).attr("width",function(){return d-l.rightPadding/2}).attr("height",i).attr("class",function(t){for(let[e,i]of M.entries())if(t.type===i)return"section section"+e%l.numberSectionStyles;return"section section0"}).enter();let h=O.append("g").selectAll("rect").data(t).enter(),f=s.db.getLinks();if(h.append("rect").attr("id",function(t){return e+"-"+t.id}).attr("rx",3).attr("ry",3).attr("x",function(t){return t.milestone?L(t.startTime)+a+.5*(L(t.endTime)-L(t.startTime))-.5*o:L(t.startTime)+a}).attr("y",function(t,e){return(e=t.order,t.vert)?l.gridLineStartPadding:e*i+n}).attr("width",function(t){return t.milestone?o:t.vert?.08*o:L(t.renderEndTime||t.endTime)-L(t.startTime)}).attr("height",function(t){return t.vert?C.length*(l.barHeight+l.barGap)+2*l.barHeight:o}).attr("transform-origin",function(t,e){return e=t.order,(L(t.startTime)+a+.5*(L(t.endTime)-L(t.startTime))).toString()+"px "+(e*i+n+.5*o).toString()+"px"}).attr("class",function(t){let e="";t.classes.length>0&&(e=t.classes.join(" "));let i=0;for(let[e,n]of M.entries())t.type===n&&(i=e%l.numberSectionStyles);let n="";return t.active?t.crit?n+=" activeCrit":n=" active":t.done?n=t.crit?" doneCrit":" done":t.crit&&(n+=" crit"),0===n.length&&(n=" task"),t.milestone&&(n=" milestone "+n),t.vert&&(n=" vert "+n),n+=i,"task"+(n+=" "+e)}),h.append("text").attr("id",function(t){return e+"-"+t.id+"-text"}).text(function(t){return t.task}).attr("font-size",l.fontSize).attr("x",function(t){let e=L(t.startTime),i=L(t.renderEndTime||t.endTime);if(t.milestone&&(e+=.5*(L(t.endTime)-L(t.startTime))-.5*o,i=e+o),t.vert)return L(t.startTime)+a;let n=this.getBBox().width;return n>i-e?i+n+1.5*l.leftPadding>d?e+a-5:i+a+5:(i-e)/2+e+a}).attr("y",function(t,e){return t.vert?l.gridLineStartPadding+C.length*(l.barHeight+l.barGap)+60:t.order*i+l.barHeight/2+(l.fontSize/2-2)+n}).attr("text-height",o).attr("class",function(t){let e=L(t.startTime),i=L(t.endTime);t.milestone&&(i=e+o);let n=this.getBBox().width,s="";t.classes.length>0&&(s=t.classes.join(" "));let r=0;for(let[e,i]of M.entries())t.type===i&&(r=e%l.numberSectionStyles);let a="";return(t.active&&(a=t.crit?"activeCritText"+r:"activeText"+r),t.done?a=t.crit?a+" doneCritText"+r:a+" doneText"+r:t.crit&&(a=a+" critText"+r),t.milestone&&(a+=" milestoneText"),t.vert&&(a+=" vertText"),n>i-e)?i+n+1.5*l.leftPadding>d?s+" taskTextOutsideLeft taskTextOutside"+r+" "+a:s+" taskTextOutsideRight taskTextOutside"+r+" "+a+" width-"+n:s+" taskText taskText"+r+" "+a+" width-"+n}),"sandbox"===(0,r.getConfig2)().securityLevel){let t=(0,m.select)("#i"+e).nodes()[0].contentDocument;h.filter(function(t){return f.has(t.id)}).each(function(i){var n=t.querySelector("#"+CSS.escape(e+"-"+i.id)),s=t.querySelector("#"+CSS.escape(e+"-"+i.id+"-text"));let r=n.parentNode;var a=t.createElement("a");a.setAttribute("xlink:href",f.get(i.id)),a.setAttribute("target","_top"),r.appendChild(a),a.appendChild(n),a.appendChild(s)})}}function W(t,i,n,r,o,d,u,h){let m,f;if(0===u.length&&0===h.length)return;for(let{startTime:t,endTime:e}of d)(void 0===m||t<m)&&(m=t),(void 0===f||e>f)&&(f=e);if(!m||!f)return;if((0,c.default)(f).diff((0,c.default)(m),"year")>5)return void a.log.warn("The difference between the min and max time is more than 5 years. This will cause performance issues. Skipping drawing exclude days.");let y=s.db.getDateFormat(),k=[],g=null,p=(0,c.default)(m);for(;p.valueOf()<=f;)s.db.isInvalidDate(p,y,u,h)?g?g.end=p:g={start:p,end:p}:g&&(k.push(g),g=null),p=p.add(1,"d");O.append("g").selectAll("rect").data(k).enter().append("rect").attr("id",t=>e+"-exclude-"+t.start.format("YYYY-MM-DD")).attr("x",t=>L(t.start.startOf("day"))+n).attr("y",l.gridLineStartPadding).attr("width",t=>L(t.end.endOf("day"))-L(t.start.startOf("day"))).attr("height",o-i-l.gridLineStartPadding).attr("transform-origin",function(e,i){return(L(e.start)+n+.5*(L(e.end)-L(e.start))).toString()+"px "+(i*t+.5*o).toString()+"px"}).attr("class","exclude-range")}function P(t,e,i,n){if(i<=0||t>e)return 1/0;let s=c.default.duration({[n??"day"]:i}).asMilliseconds();return s<=0?1/0:Math.ceil((e-t)/s)}function H(t,e,i,n){let r,o=s.db.getDateFormat(),c=s.db.getAxisFormat();r=c||("D"===o?"%d":l.axisFormat??"%Y-%m-%d");let d=(0,_.axisBottom)(L).tickSize(-n+e+l.gridLineStartPadding).tickFormat((0,T.timeFormat)(r)),u=/^([1-9]\d*)(millisecond|second|minute|hour|day|week|month)$/.exec(s.db.getTickInterval()||l.tickInterval);if(null!==u){let t=parseInt(u[1],10);if(isNaN(t)||t<=0)a.log.warn(`Invalid tick interval value: "${u[1]}". Skipping custom tick interval.`);else{let e=u[2],i=s.db.getWeekday()||l.weekday,n=L.domain(),r=P(n[0],n[1],t,e);if(r>1e4)a.log.warn(`The tick interval "${t}${e}" would generate ${r} ticks, which exceeds the maximum allowed (10000). This may indicate an invalid date or time range. Skipping custom tick interval.`);else switch(e){case"millisecond":d.ticks(v.timeMillisecond.every(t));break;case"second":d.ticks(x.timeSecond.every(t));break;case"minute":d.ticks(b.timeMinute.every(t));break;case"hour":d.ticks($.timeHour.every(t));break;case"day":d.ticks(w.timeDay.every(t));break;case"week":d.ticks(tZ[i].every(t));break;case"month":d.ticks(S.timeMonth.every(t))}}}if(O.append("g").attr("class","grid").attr("transform","translate("+t+", "+(n-50)+")").call(d).selectAll("text").style("text-anchor","middle").attr("fill","#000").attr("stroke","none").attr("font-size",10).attr("dy","1em"),s.db.topAxisEnabled()||l.topAxis){let i=(0,_.axisTop)(L).tickSize(-n+e+l.gridLineStartPadding).tickFormat((0,T.timeFormat)(r));if(null!==u){let t=parseInt(u[1],10);if(isNaN(t)||t<=0)a.log.warn(`Invalid tick interval value: "${u[1]}". Skipping custom tick interval.`);else{let e=u[2],n=s.db.getWeekday()||l.weekday,r=L.domain();if(1e4>=P(r[0],r[1],t,e))switch(e){case"millisecond":i.ticks(v.timeMillisecond.every(t));break;case"second":i.ticks(x.timeSecond.every(t));break;case"minute":i.ticks(b.timeMinute.every(t));break;case"hour":i.ticks($.timeHour.every(t));break;case"day":i.ticks(w.timeDay.every(t));break;case"week":i.ticks(tZ[n].every(t));break;case"month":i.ticks(S.timeMonth.every(t))}}}O.append("g").attr("class","grid").attr("transform","translate("+t+", "+e+")").call(i).selectAll("text").style("text-anchor","middle").attr("fill","#000").attr("stroke","none").attr("font-size",10)}}function z(t,e){let i=0,n=Object.keys(E).map(t=>[t,E[t]]);O.append("g").selectAll("text").data(n).enter().append(function(t){let e=t[0].split(r.common_default.lineBreakRegex),i=-(e.length-1)/2,n=h.createElementNS("http://www.w3.org/2000/svg","text");for(let[t,s]of(n.setAttribute("dy",i+"em"),e.entries())){let e=h.createElementNS("http://www.w3.org/2000/svg","tspan");e.setAttribute("alignment-baseline","central"),e.setAttribute("x","10"),t>0&&e.setAttribute("dy","1em"),e.textContent=s,n.appendChild(e)}return n}).attr("x",10).attr("y",function(s,r){if(!(r>0))return s[1]*t/2+e;for(let a=0;a<r;a++)return i+=n[r-1][1],s[1]*t/2+i*t+e}).attr("font-size",l.sectionFontSize).attr("class",function(t){for(let[e,i]of M.entries())if(t[0]===i)return"sectionTitle sectionTitle"+e%l.numberSectionStyles;return"sectionTitle"})}function B(t,e,i,n){let r=s.db.getTodayMarker();if("off"===r)return;let a=O.append("g").attr("class","today"),o=new Date,c=a.append("line");c.attr("x1",L(o)+t).attr("x2",L(o)+t).attr("y1",l.titleTopMargin).attr("y2",n-l.titleTopMargin).attr("class","today"),""!==r&&c.attr("style",r.replace(/,/g,";"))}function N(t){let e={},i=[];for(let n=0,s=t.length;n<s;++n)Object.prototype.hasOwnProperty.call(e,t[n])||(e[t[n]]=!0,i.push(t[n]));return i}(0,a.__name)(A,"taskCompare"),C.sort(A),I(C,n,Y),(0,r.configureSvgSize)(O,Y,n,l.useMaxWidth),O.append("text").text(s.db.getDiagramTitle()).attr("x",n/2).attr("y",l.titleTopMargin).attr("class","titleText"),(0,a.__name)(I,"makeGantt"),(0,a.__name)(F,"drawRects"),(0,a.__name)(W,"drawExcludeDays"),(0,a.__name)(P,"getEstimatedTickCount"),(0,a.__name)(H,"makeGrid"),(0,a.__name)(z,"vertLabels"),(0,a.__name)(B,"drawToday"),(0,a.__name)(N,"checkUnique")},"draw")},styles:(0,a.__name)(t=>`
  .mermaid-main-font {
        font-family: ${t.fontFamily};
  }

  .exclude-range {
    fill: ${t.excludeBkgColor};
  }

  .section {
    stroke: none;
    opacity: 0.2;
  }

  .section0 {
    fill: ${t.sectionBkgColor};
  }

  .section2 {
    fill: ${t.sectionBkgColor2};
  }

  .section1,
  .section3 {
    fill: ${t.altSectionBkgColor};
    opacity: 0.2;
  }

  .sectionTitle0 {
    fill: ${t.titleColor};
  }

  .sectionTitle1 {
    fill: ${t.titleColor};
  }

  .sectionTitle2 {
    fill: ${t.titleColor};
  }

  .sectionTitle3 {
    fill: ${t.titleColor};
  }

  .sectionTitle {
    text-anchor: start;
    font-family: ${t.fontFamily};
  }


  /* Grid and axis */

  .grid .tick {
    stroke: ${t.gridColor};
    opacity: 0.8;
    shape-rendering: crispEdges;
  }

  .grid .tick text {
    font-family: ${t.fontFamily};
    fill: ${t.textColor};
  }

  .grid path {
    stroke-width: 0;
  }


  /* Today line */

  .today {
    fill: none;
    stroke: ${t.todayLineColor};
    stroke-width: 2px;
  }


  /* Task styling */

  /* Default task */

  .task {
    stroke-width: 2;
  }

  .taskText {
    text-anchor: middle;
    font-family: ${t.fontFamily};
  }

  .taskTextOutsideRight {
    fill: ${t.taskTextDarkColor};
    text-anchor: start;
    font-family: ${t.fontFamily};
  }

  .taskTextOutsideLeft {
    fill: ${t.taskTextDarkColor};
    text-anchor: end;
  }


  /* Special case clickable */

  .task.clickable {
    cursor: pointer;
  }

  .taskText.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }

  .taskTextOutsideLeft.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }

  .taskTextOutsideRight.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }


  /* Specific task settings for the sections*/

  .taskText0,
  .taskText1,
  .taskText2,
  .taskText3 {
    fill: ${t.taskTextColor};
  }

  .task0,
  .task1,
  .task2,
  .task3 {
    fill: ${t.taskBkgColor};
    stroke: ${t.taskBorderColor};
  }

  .taskTextOutside0,
  .taskTextOutside2
  {
    fill: ${t.taskTextOutsideColor};
  }

  .taskTextOutside1,
  .taskTextOutside3 {
    fill: ${t.taskTextOutsideColor};
  }


  /* Active task */

  .active0,
  .active1,
  .active2,
  .active3 {
    fill: ${t.activeTaskBkgColor};
    stroke: ${t.activeTaskBorderColor};
  }

  .activeText0,
  .activeText1,
  .activeText2,
  .activeText3 {
    fill: ${t.taskTextDarkColor} !important;
  }


  /* Completed task */

  .done0,
  .done1,
  .done2,
  .done3 {
    stroke: ${t.doneTaskBorderColor};
    fill: ${t.doneTaskBkgColor};
    stroke-width: 2;
  }

  .doneText0,
  .doneText1,
  .doneText2,
  .doneText3 {
    fill: ${t.taskTextDarkColor} !important;
  }

  /* Done task text displayed outside the bar sits against the diagram background,
     not against the done-task bar, so it must use the outside/contrast color. */
  .doneText0.taskTextOutsideLeft,
  .doneText0.taskTextOutsideRight,
  .doneText1.taskTextOutsideLeft,
  .doneText1.taskTextOutsideRight,
  .doneText2.taskTextOutsideLeft,
  .doneText2.taskTextOutsideRight,
  .doneText3.taskTextOutsideLeft,
  .doneText3.taskTextOutsideRight {
    fill: ${t.taskTextOutsideColor} !important;
  }


  /* Tasks on the critical line */

  .crit0,
  .crit1,
  .crit2,
  .crit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.critBkgColor};
    stroke-width: 2;
  }

  .activeCrit0,
  .activeCrit1,
  .activeCrit2,
  .activeCrit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.activeTaskBkgColor};
    stroke-width: 2;
  }

  .doneCrit0,
  .doneCrit1,
  .doneCrit2,
  .doneCrit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.doneTaskBkgColor};
    stroke-width: 2;
    cursor: pointer;
    shape-rendering: crispEdges;
  }

  .milestone {
    transform: rotate(45deg) scale(0.8,0.8);
  }

  .milestoneText {
    font-style: italic;
  }
  .doneCritText0,
  .doneCritText1,
  .doneCritText2,
  .doneCritText3 {
    fill: ${t.taskTextDarkColor} !important;
  }

  /* Done-crit task text outside the bar \u2014 same reasoning as doneText above. */
  .doneCritText0.taskTextOutsideLeft,
  .doneCritText0.taskTextOutsideRight,
  .doneCritText1.taskTextOutsideLeft,
  .doneCritText1.taskTextOutsideRight,
  .doneCritText2.taskTextOutsideLeft,
  .doneCritText2.taskTextOutsideRight,
  .doneCritText3.taskTextOutsideLeft,
  .doneCritText3.taskTextOutsideRight {
    fill: ${t.taskTextOutsideColor} !important;
  }

  .vert {
    stroke: ${t.vertLineColor};
  }

  .vertText {
    font-size: 15px;
    text-anchor: middle;
    fill: ${t.vertLineColor} !important;
  }

  .activeCritText0,
  .activeCritText1,
  .activeCritText2,
  .activeCritText3 {
    fill: ${t.taskTextDarkColor} !important;
  }

  .titleText {
    text-anchor: middle;
    font-size: 18px;
    fill: ${t.titleColor||t.textColor};
    font-family: ${t.fontFamily};
  }
`,"getStyles")}}]);