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


function domain(url) {
  return url.replace(/^[^.]+\./g, ""); 
}

function parse(body) {
  const me = [];
  let fullName;
  let givenName;
  let familyName;;
  let photo;
  let email;
  let color;
  let backgroundColor;
  let username;
  let indieauth;
  let logo;
  const parser = new Parser({
    onopentag(name, attributes) {
      const { rel, name: value, href, content } = attributes;
      if (name === "link" && rel === "me") {
        me.push(href);
      } else if (name === "link" && rel === "indieauth-metadata") {
        indieauth = href;
      } else if (name === "link" && rel === "logo") {
        logo = href;
      } else if (name === "meta" && value === "name") {
        fullName = content;
      } else if (name === "meta" && value === "given-name") {
        givenName = content;
      } else if (name === "meta" && value === "family-name") {
        familyName = content;
      } else if (name === "meta" && value === "email") {
        email = content;
      } else if (name === "meta" && value === "photo") {
        photo = content;
      } else if (name === "meta" && value === "username") {
        username = content;
      } else if (name === "meta" && value === "color") {
        color = content;
      } else if (name === "meta" && value === "background-color") {
        backgroundColor = content;
      }
    },
  });
  parser.write(body);
  parser.end();
  const profile = {
    me: me,
    name: fullName,
    givenName: givenName,    
    familyName: familyName,    
    email: email,
    username: username,
    logo: logo,  
    photo: photo,    
    color: color,    
    backgroundColor: backgroundColor,
    indieauth: indieauth,
  };

  // console.log(profile);
  
  return profile;
}

async function finger(url) {
  const me = [];
  
  try {
    const records = await dns.promises.resolveTxt(`me.${domain(url)}`);
    me.push(...records.flat());
    // console.log(`Got records from the DNS entry! ${records}`);
  } catch (e) {
    // console.log(`Error fetching the DNS records in ${domain}`);
  }
  
  // console.log(me.flat());
  
  const profile = {};
  
  try {
    const response = await fetch(`https://${domain(url)}`);
    const body = await response.text();
    const result = parse(body);
    const {me: links} = result;
    Object.assign(profile, result);
    me.push(...links);
  } catch (e) {
    // console.log(`Error fetching the HTML page in ${domain}`);
  } 
  
  const github = me.filter((url) => {
    try {
      return new URL(url).host == "github.com";
    } catch (e) {
      return false;
    }
  });
  
  if (github.length == 0) {
    return [];
  }

  const usernames = github.map((url) => new URL(url).pathname.substring(1));
  
  // Remove duplicates
  profile.usernames = [...new Set(usernames)];
  return profile;
}

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
  const { code, url } = req.query;

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

  // const url = state;
  
  // const hostname = req.hostname;
  // var domain = hostname.replace(/^[^.]+\./g, "");
  
  // console.log(url);
  const { login, avatar_url, name, blog, email } = await user.json();    

  const self = await finger(url);
    
  if (self.usernames.length == 0) {
    res.send("You need at least one link rel='me' href='https://github.com/username' in ${url}");
    return;
  }
  
  if (!process.env.DISABLE_GITHUB_CHECK && !self.usernames.includes(login)) {
    res.send(
      `${login} isn't included in the list of rel=me usernames ${self.usernames}`
    );
    return;
  }

  // res.set("Set-Login", "logged-in");

  req.session.loggedin = true;
  req.session.domain = `https://${domain(url)}`;
  req.session.url = url;  
  req.session.username = self.username || login;
  req.session.photo = self.photo || avatar_url;
  req.session.name = self.name || name;
  req.session.givenName = self.givenName;
  req.session.email = self.email || email;
  
  // TODO(goto): it is a bit awkward that I have to send a HTML
  // file just to call IdentityProvider.close(). Maybe we should
  // have a HTTP header version of it.
  res.send(`
  <script type="module">
    if (IdentityProvider) {
      // Signal to the browser that the user has signed in.
      IdentityProvider.close();
      await navigator.login.setStatus("logged-in", {
        accounts: [{
          id: "${req.session.username}",
          name: "${req.session.name}",
          givenName: "${req.session.givenName}",
          email: "${req.session.email}",
          picture: "${req.session.photo}"
        }]
      });
    }
    window.location.href = "/";
  </script>
  `);
});

app.get("/github/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    res.send("Ooops, something went wrong: code not received.");
    return;
  }
  
  let url = state;
  
  const params = querystring.stringify({
    code: code,
    url: url
  });
  
  res.redirect(`${url}/callback?${params}`);
});

app.get("/login", async (req, res) => {
  const url = req.query.url ? req.query.url : `${req.protocol}://${req.hostname}`;

  console.log(`${process.env.GITHUB_REDIRECT_DOMAIN}/github/callback`);
  const params = querystring.stringify({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: `${process.env.GITHUB_REDIRECT_DOMAIN}/github/callback`,
    scope: ["read:user", "user:email"].join(" "), // space seperated string
    allow_signup: true,
    state: url,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);

  return;
});

app.use("/test/fedcm.json", async function (req, res, next) {
    const me = `${req.protocol}://${req.hostname}`;

    const {
	logo,
	color,
	backgroundColor,
    } = await finger(me);

    console.log(`Fetching configURL for ${me}`);
  
  res.send({
      accounts_endpoint: "/accounts",
      id_token_endpoint: "/idtoken_endpoint.json",
      client_metadata_endpoint: "/client_metadata",
      id_assertion_endpoint: "/id_assertion_endpoint",
      revocation_endpoint: "/revoke_endpoint.json",
      metrics_endpoint: "/metrics_endpoint.json",
      login_url: "/",
      types: ["indieauth"],
      branding: {
	  background_color: backgroundColor || "green",
	  color: color || "#FFEEAA",
	  icons: [{
              url: logo || "https://static.thenounproject.com/png/362206-200.png",
	  }],
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

  const { domain, username, name, givenName, email, photo } = req.session;

  res.send({
    accounts: [
      {
        id: domain,
        account_id: domain,
        email: domain || email,
        name: name,
        given_name: givenName,
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

  const code = String(Math.random());

  const { domain, username, name, givenName, email, photo } = req.session;

  tokens[code] = {
    url: url,
    domain: domain,
    account_id: domain,
    email: email,
    name: name,
    given_name: givenName,
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

  const { domain, account_id, email, name, given_name, picture } = tokens[code];

  console.log(domain);

  res.send({
    me: domain,
    profile: {
      name: name,
      url: domain,
      photo: picture,
      email: email,
    },
  });
});

app.use(express.static("public"));

app.use("/logout", (req, res) => {
  res.set("Set-Login", "logged-out");
  req.session.destroy();
  res.redirect("/?logout=true");
});

app.get("/", async (req, res) => {
  const { loggedin, url } = req.session;
  
  const me = req.query.domain ? `https://${req.query.domain}` : `${req.protocol}://${req.hostname}`;

  const {
    usernames: [handle],
    username,
    name,    
    givenName,
    familyName,
    email,
    photo,
    logo,
    color,
    backgroundColor,
    indieauth
  } = await finger(me);
  
  // console.log(await finger(me));
  if (!handle) {
    res.send(`You need at least one github account linked to https://${domain(me)}.`);
    return;
  }    

  if (!req.session.loggedin) {

    if (!req.query.logout) {
      res.redirect("/login");
      return;
    } 


    res.send(`
      <br>Click <a href="/login">here</a> to login to https://${domain(me)} as <b>@${handle}</b> at github.com!
    `);
    return;
  }
  
  res.send(`
    <h1>Welcome ${me}!</h1>
    
    <br><br>Click <a href="/logout">here</a> to logout.
    <br>
      
    <br>Here is what we know about you that you declared on <a href="https://${domain(me)}">https://${domain(me)}</a>.
      
    <br>
      
    <br>Required setup:
    <ul>
      <li>Github username: <b>${handle}</b> (required)</li>
      <li>IndieAuth: <a href="${indieauth}">${indieauth}</a> (required)</li>
    </ul>

    <br>User Profile (optional):
    <ul>
      <li>Name: ${name} (optional)</li>
      <li>Given name: ${givenName} (optional)</li>
      <li>Family name: ${familyName} (optional)</li>
      <li>Email: ${email} (optional)</li>
      <li>Username: ${username} (optional)</li>
      <li>Photo: <a href="${photo}">${photo}</a> (optional)</li>
    </ul>

    <br>Branding (optional):
    <ul>
      <li>Logo: <a href="${logo}">${logo}</a> (optional)</li>
      <li>Color: ${color} (optional)</li>
      <li>Background color: ${backgroundColor} (optional)</li>
    </ul>

    <br>Register as an IdP
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

