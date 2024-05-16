const express = require("express");
const app = express();
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');

app.use(bodyParser.json()) // for parsing application/json
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/.well-known/web-identity', (req, res) => {
  res.send({
    "provider_urls": [
      "https://fedcm.glitch.me/test/fedcm.json"
    ]
  });
})

app.use('/test/fedcm.json', function(req, res, next) {
  res.send({
    "accounts_endpoint": "/accounts",
    "id_token_endpoint": "/idtoken_endpoint.json",
    "client_metadata_endpoint": "/client_metadata",
    "id_assertion_endpoint": "/id_assertion_endpoint",
    "revocation_endpoint": "/revoke_endpoint.json",
    "metrics_endpoint": "/metrics_endpoint.json",
    "signin_url": "/signin",
    "login_url": "/signin",
    "branding": {
      "icons": [{
          "url": "https://static.thenounproject.com/png/362206-200.png",
        }
      ]
    }
  });
});

app.use("/accounts", (req, res) => {
  res.send({
    "accounts" : [{ 
        "id": "samuelgoto",
        "account_id": "samuelgoto",
        "email": "samuelgoto@gmail.com", 
        "name":"Sam Goto",
        "given_name": "Sam",
        "picture": "https://pbs.twimg.com/profile_images/920758039325564928/vp0Px4kC_400x400.jpg"
      }
    ]
  });
});

app.use("/client_metadata", (req, res) => {
  // Check for the CORS headers
  res.send({
    "privacy_policy_url": "https://rp.example/privacy_policy.html",
    "terms_of_service_url": "https://rp.example/terms_of_service.html",
  });
});


app.post("/id_assertion_endpoint", (request, response) => {
  response.set('Access-Control-Allow-Origin', request.headers.origin);
  response.set('Access-Control-Allow-Credentials', 'true');
  
  const subject = request.body["account_id"];
    
  response.json({
    "token" : JSON.stringify({
      code: "hello world",
      metadata_endpoint: "https://fedcm.glitch.me/indieauth/metadata_endpoint"
    })
  });
});


app.get("/indieauth/metadata_endpoint", (req, res) => {
  res.send({
    "issuer": "https://fedcm.glitch.me/",
    "token_endpoint": "https://fedcm.glitch.me/indieauth/token_endpoint",
  });
});

app.post("/indieauth/token_endpoint", (req, res) => {
  const {grant_type, code, client_id, code_verifier} = req.body;
  res.send({
    "me": "https://code.sgo.to",
    "profile": {
      "name": "Sam Goto",
      "url": "https://code.sgo.to",
      "photo": "https://pbs.twimg.com/profile_images/920758039325564928/vp0Px4kC_400x400.jpg",
      "email": "samuelgoto@gmail.com"
    }
  });
});


app.use(express.static("public"));

app.use("/login", (req, res) => {
    res.set("Set-Login", "logged-in");
    res.redirect("/");  
});

app.use("/logout", (req, res) => {
    res.set("Set-Login", "logged-out");
    res.redirect("/");  
});


app.get("/", (request, response) => {
  response.sendFile(__dirname + "/public/index.html");
});

// listen for requests :)
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});





