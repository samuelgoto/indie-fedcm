const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { Parser } = require("htmlparser2");
var querystring = require("querystring");
const session = require("express-session");
const dns = require("dns");


app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.COOKIE_SECRET,
    resave: true,
    proxy: true,
    cookie: { 
      maxAge: 24 * 60 * 60 * 1000 * 7, //seven days
      secure: true,
      sameSite: "None",
    },
    saveUninitialized: true,
  })
);

function relative(req, path) {
  return `https://${req.hostname}${path}`;
}

app.get("/:url/foo", async (req, res) => {
  console.log(req.params.url);
  res.send("hi");
});

app.use("/.well-known/web-identity", async (req, res) => {
  res.send({
    provider_urls: [relative(req, "/test/fedcm.json")],
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
    res.send(`Oops, there was an error: ${error}`);
    return;
  }

  const user = await fetch(`https://api.github.com/user`, {
    headers: {
      Authorization: `token ${access_token}`,
    },
  });

  const url = state;
  
  const me = [];
  
  try {
    const records = await dns.promises.resolveTxt(`me.${new URL(url).hostname}`);
    me.push(...records.flat());
    console.log(`Got records from the DNS entry! ${records}`);
  } catch (e) {
    console.log(`Error fetching the DNS records in ${url}`);
  }
  
  // console.log(me.flat());
  
  try {
    const response = await fetch(url);
    const body = await response.text();
    const links = parseRel(body);
    me.push(...links);
  } catch (e) {
    console.log(`Error fetching the HTML page in ${url}`);
  }

  const github = me.filter((url) => {
    try {
      return new URL(url).host == "github.com";
    } catch (e) {
      return false;
    }
  });

  // All rel links
  console.log(me);
  
  if (github.length == 0) {
    res.send(
      "You need at least one <link rel='me' href='https://github.com/username'> in your url"
    );
    return;
  }

  const usernames = github.map((url) => new URL(url).pathname.substring(1));

  const { login, avatar_url, name, blog, email } = await user.json();

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
  
  // TODO(goto): it is a bit awkward that I have to send a HTML
  // file just to call IdentityProvider.close(). Maybe we should
  // have a HTTP header version of it.
  res.send(`
  <script>
    if (IdentityProvider) {
      // Signal to the browser that the user has signed in.
      IdentityProvider.close(); 
    }
    window.location.href = "/";
  </script>
  `);
});

app.get("/login", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    res.send("Missing url parameter");
    return;
  }

  const params = querystring.stringify({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: relative(req, "/callback"),
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
    login_url: "/",
    branding: {
      icons: [
        {
          url: "https://static.thenounproject.com/png/362206-200.png",
        },
      ],
    },
  });
});

function error(res, message) {
  return res.status(400).end();
}

app.use("/accounts", (req, res) => {
  const { loggedin, url } = req.session;

  if (!loggedin) {
    return error(res, {});
  }

  const { username, name, email, photo } = req.session;

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

const tokens = {};

app.post("/id_assertion_endpoint", (req, res) => {
  const { loggedin, url } = req.session;

  if (!loggedin) {
    return error(res, {});
  }

  res.set("Access-Control-Allow-Origin", req.headers.origin);
  res.set("Access-Control-Allow-Credentials", "true");

  const subject = req.body["account_id"];

  const code = Math.random();

  const { username, name, email, photo } = req.session;

  tokens[code] = {
    url: url,
    id: url,
    account_id: username,
    email: email ? email : url,
    name: name,
    given_name: name,
    picture: photo,
  };

  res.json({
    token: JSON.stringify({
      code: code,
      metadata_endpoint: relative(req, "/indieauth/metadata_endpoint"),
    }),
  });
});

app.get("/indieauth/metadata_endpoint", (req, res) => {
  res.send({
    issuer: relative(req, "/"),
    token_endpoint: relative(req, "/indieauth/token_endpoint"),
  });
});

app.post("/indieauth/token_endpoint", (req, res) => {
  console.log("hello world from the token endpoint!");
  const { grant_type, code, client_id, code_verifier } = req.body;

  if (!tokens[code]) {
    return error(res, `Unknown code: ${code}.`);
  }

  const { id, account_id, email, name, given_name, picture } = tokens[code];

  res.send({
    me: id,
    profile: {
      name: name,
      url: id,
      photo: picture,
      email: email,
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
  const { loggedin, url } = req.session;

  if (!req.session.loggedin) {
    res.send(`
      You are logged-out. 
      <br><br>Enter your IndieAuth domain here to login:
      <br><br><form action='/login'><input name='url'><input type='submit' value='login'></form>
    `);
    return;
  }

  res.send(`
    You are logged-in as ${url}. <a href="/logout">logout</a>.
    <ul>
      <li><a href="javascript:IdentityProvider.register('${relative(
        req,
        "/test/fedcm.json"
      )}')">Register</a></li>
      <li><a href="javascript:IdentityProvider.unregister('${relative(
        req,
        "/test/fedcm.json"
      )}')">Unregister</a></li>
    </ul>
  `);
});

// listen for requests :)
const listener = app.listen(process.env.PORT, async () => {
  
  // console.log(dns.promises); 
  
  if (!process.env.GITHUB_CLIENT_ID) {
    throw new Error("You need to set a GITHUB_CLIENT_ID environment variable");
  }

  if (!process.env.GITHUB_CLIENT_SECRET) {
    throw new Error(
      "You need to set a GITHUB_CLIENT_SECRET environment variable"
    );
  }

  if (!process.env.COOKIE_SECRET) {
    throw new Error("You need to set a COOKIE_SECRET environment variable");
  }

  console.log("Your app is listening on port " + listener.address().port);
});
