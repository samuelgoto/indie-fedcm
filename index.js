const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { Parser } = require("htmlparser2");
var querystring = require("querystring");
const session = require("express-session");

app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.COOKIE_SECRET,
  resave: true,
  proxy: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000 * 7, //seven days
    secure: true,
    sameSite: 'None'
  },
  saveUninitialized: true
}));

app.use("/.well-known/web-identity", async (req, res) => {
  res.send({
    provider_urls: ["https://fedcm.glitch.me/test/fedcm.json"],
  });
});

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  const params = querystring.stringify({
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    code: code,
  });

  const accessToken = await fetch(
    `https://github.com/login/oauth/access_token?${params}`
  );

  const { access_token, scope, token_type, error } = querystring.parse(
    await accessToken.text()
  );

  if (error) {
    res.send("Oops, there was an error");
    return;
  }

  const user = await fetch(`https://api.github.com/user`, {
    headers: {
      Authorization: `token ${access_token}`,
    },
  });

  const url = state;
  const response = await fetch(url);
  const body = await response.text();
  const me = parseRel(body);

  const github = me.filter((url) => {
    try {
      return new URL(url).host == "github.com";
    } catch (e) {
      return false;
    }
  });

  if (github.length == 0) {
    res.send(
      "You need at least one <link rel='me' href='https://github.com/username'> in your url"
    );
    return;
  }

  const usernames = github.map((url) => new URL(url).pathname.substring(1));

  const { login, avatar_url, name, blog, email} = await user.json();

  if (!usernames.includes(login)) {
    res.send(
      `${login} isn't included in the list of rel=me usernames ${usernames}`
    );
    return;
  }

  res.set("Set-Login", "logged-in");

  req.session.loggedin = true;
  req.session.url = url;
  req.session.username = login;
  req.session.photo = avatar_url;
  req.session.name = name;

  res.redirect("/");
});

app.get("/login", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    res.send("Missing url parameter");
    return;
  }

  const params = querystring.stringify({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: "https://fedcm.glitch.me/callback",
    scope: ["read:user", "user:email"].join(" "), // space seperated string
    allow_signup: true,
    state: url,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);

  return;
});

function parseRel(body) {
  const me = [];
  const parser = new Parser({
    onopentag(name, { rel, href }) {
      if (name === "link" && rel === "me") {
        me.push(href);
      }
    },
  });
  parser.write(body);
  parser.end();
  return me;
}

app.use("/test/fedcm.json", function (req, res, next) {
  res.send({
    accounts_endpoint: "/accounts",
    id_token_endpoint: "/idtoken_endpoint.json",
    client_metadata_endpoint: "/client_metadata",
    id_assertion_endpoint: "/id_assertion_endpoint",
    revocation_endpoint: "/revoke_endpoint.json",
    metrics_endpoint: "/metrics_endpoint.json",
    signin_url: "/signin",
    login_url: "/signin",
    branding: {
      icons: [{
          url: "https://static.thenounproject.com/png/362206-200.png",
      }],
    },
  });
});

function error(res, message) {
  return res.status(400).end();
}

app.use("/accounts", (req, res) => {
  const {loggedin, url} = req.session;
  
  if (!loggedin) {
    return error(res, {});
  }

  const {username, name, email, photo} = req.session;
  
  res.send({
    accounts: [
      {
        id: url,
        account_id: username,
        email: email ? email : url,
        name: name,
        given_name: name,
        picture: photo,
      },
    ],
  });
});

app.use("/client_metadata", (req, res) => {
  // Check for the CORS headers
  res.send({
    privacy_policy_url: "https://rp.example/privacy_policy.html",
    terms_of_service_url: "https://rp.example/terms_of_service.html",
  });
});

app.post("/id_assertion_endpoint", (request, response) => {
  response.set("Access-Control-Allow-Origin", request.headers.origin);
  response.set("Access-Control-Allow-Credentials", "true");

  const subject = request.body["account_id"];

  response.json({
    token: JSON.stringify({
      code: "hello world",
      metadata_endpoint: "https://fedcm.glitch.me/indieauth/metadata_endpoint",
    }),
  });
});

app.get("/indieauth/metadata_endpoint", (req, res) => {
  res.send({
    issuer: "https://fedcm.glitch.me/",
    token_endpoint: "https://fedcm.glitch.me/indieauth/token_endpoint",
  });
});

app.post("/indieauth/token_endpoint", (req, res) => {
  console.log("hello world from the token endpoint!");
  const { grant_type, code, client_id, code_verifier } = req.body;
  res.send({
    me: "https://code.sgo.to",
    profile: {
      name: "Sam Goto",
      url: "https://code.sgo.to",
      photo:
        "https://pbs.twimg.com/profile_images/920758039325564928/vp0Px4kC_400x400.jpg",
      email: "samuelgoto@gmail.com",
    },
  });
});

app.use(express.static("public"));

app.use("/logout", (req, res) => {
  res.set("Set-Login", "logged-out");
  req.session.destroy();
  res.redirect("/");
});

app.get("/", (req, res) => {
  const {loggedin, url} = req.session;

  if (!req.session.loggedin) {
    res.send(`
      You are logged-out. 
      <form action='/login'><input name='url'><input type='submit' value='login'></form>
    `);    
    return;
  }

  res.send(`
    You are logged-in as ${url}. <a href="/logout">logout</a>.
    <ul>
      <li><a href="javascript:IdentityProvider.register('https://fedcm.glitch.me/test/fedcm.json')">Register</a></li>
      <li><a href="javascript:IdentityProvider.unregister('https://fedcm.glitch.me/test/fedcm.json')">Unregister</a></li>
    </ul>
  `);
});

// listen for requests :)
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
